// Stealth / farm-guard: anti-coorte para quem opera muitas contas.
// - rotacao de User-Agent e Accept-Language (tira a assinatura fixa Chrome/136)
// - proxy por conta (http/socks5, com ou sem auth) via reqwest
// - cooldown com jitter + quarentena automatica ao tomar 429/403/phone/face
// - jitter e randomizacao de janela/delay pro signup parecer humano
//
// Nada aqui resolve captcha sozinho: o objetivo e nao queimar o IP e nao
// vincular a leva inteira como um unico farm.

use std::collections::HashMap;
use std::time::Duration;

const UA_POOL: &[&str] = &[
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/131.0.0.0 Safari/537.36",
];

const LANG_POOL: &[&str] = &[
    "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
    "pt-BR,pt;q=0.8,en;q=0.7",
    "en-US,en;q=0.9,pt-BR;q=0.8,pt;q=0.7",
    "en-US,en;q=0.9",
];

fn rand_range(min: usize, max: usize) -> usize {
    use rand::Rng;
    if max <= min {
        return min;
    }
    rand::thread_rng().gen_range(min..=max)
}

pub fn pick_ua() -> &'static str {
    UA_POOL[rand_range(0, UA_POOL.len() - 1)]
}

pub fn pick_lang() -> &'static str {
    LANG_POOL[rand_range(0, LANG_POOL.len() - 1)]
}

/// Jitter de 700-2200ms entre requests para nao parecer rajada de bot.
pub async fn human_gap() {
    let ms = rand_range(700, 2200) as u64;
    tokio::time::sleep(Duration::from_millis(ms)).await;
}

/// Delay longo com jitter para fila de farm (ex: base 8min +- 40%).
pub fn farm_delay_ms(base_ms: u64) -> u64 {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let factor: f64 = rng.gen_range(0.6..1.4);
    ((base_ms as f64) * factor) as u64
}

/// Tamanho/posicao aleatoria pra janela de signup nao ser sempre 560x840 no centro.
pub fn random_signup_window() -> (f64, f64) {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let w: f64 = rng.gen_range(540.0..640.0);
    let h: f64 = rng.gen_range(780.0..900.0);
    (w, h)
}

// ---- proxy ----
// Formatos aceitos (um por linha nas settings `farmProxies`):
//   http://user:pass@host:port
//   socks5://user:pass@host:port
//   host:port (assume http)
pub fn normalize_proxy(raw: &str) -> Option<String> {
    let t = raw.trim();
    if t.is_empty() {
        return None;
    }
    if t.contains("://") {
        Some(t.to_string())
    } else {
        Some(format!("http://{}", t))
    }
}

pub fn build_client_with_proxy(proxy_url: Option<&str>) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15));
    if let Some(p) = proxy_url.and_then(normalize_proxy) {
        let proxy = reqwest::Proxy::all(&p).map_err(|e| format!("proxy invalido: {}", e))?;
        builder = builder.proxy(proxy);
    }
    builder.build().map_err(|e| e.to_string())
}

pub fn pick_proxy(proxies: &[String], index: usize) -> Option<String> {
    if proxies.is_empty() {
        return None;
    }
    let clean: Vec<String> = proxies
        .iter()
        .filter_map(|p| normalize_proxy(p))
        .collect();
    if clean.is_empty() {
        return None;
    }
    Some(clean[index % clean.len()].clone())
}

// Lista de proxies vinda das settings `farmProxies` (array de strings).
// Sem proxy configurado = comportamento antigo (IP direto).
pub fn load_proxy_list() -> Vec<String> {
    let s = crate::settings::load_settings();
    s.get("farmProxies")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(|x| x.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn hash_key(key: &str) -> usize {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    key.hash(&mut h);
    h.finish() as usize
}

/// Retorna um client com proxy dedicado pra essa chave (sticky por conta).
/// Cacheado em state.proxy_clients pra nao reconstruir TLS toda hora.
pub fn client_for(state: &crate::state::AppState, key: &str) -> reqwest::Client {
    let proxies = load_proxy_list();
    if proxies.is_empty() {
        return state.http.clone();
    }
    let clean: Vec<String> = proxies.iter().filter_map(|p| normalize_proxy(p)).collect();
    if clean.is_empty() {
        return state.http.clone();
    }
    let proxy_url = clean[hash_key(key) % clean.len()].clone();
    {
        let cache = state.proxy_clients.lock().unwrap();
        if let Some(c) = cache.get(&proxy_url) {
            return c.clone();
        }
    }
    match build_client_with_proxy(Some(&proxy_url)) {
        Ok(c) => {
            state
                .proxy_clients
                .lock()
                .unwrap()
                .insert(proxy_url, c.clone());
            c
        }
        Err(_) => state.http.clone(),
    }
}

// ---- farm guard ----
// Guarda em memoria: ultimo uso por chave (ip/conta), falhas seguidas e
// quarentena ate quando. Chamado antes de ticket/signup/launch em lote.
#[derive(Default)]
pub struct FarmGuard {
    last_use_ms: HashMap<String, i64>,
    fails: HashMap<String, u32>,
    quarantine_until_ms: HashMap<String, i64>,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

impl FarmGuard {
    /// Retorna Some(ms_para_esperar) se deve aguardar/quarentena.
    pub fn check(&mut self, key: &str, min_gap_ms: i64) -> Option<i64> {
        let now = now_ms();
        if let Some(until) = self.quarantine_until_ms.get(key) {
            if now < *until {
                return Some(*until - now);
            }
        }
        if let Some(last) = self.last_use_ms.get(key) {
            let gap = now - *last;
            // jitter de +-30% no gap minimo pra nao ficar metronomo
            let jittered = (min_gap_ms as f64 * 0.7) as i64;
            if gap < jittered {
                return Some(jittered - gap);
            }
        }
        None
    }

    pub fn mark_use(&mut self, key: &str) {
        self.last_use_ms.insert(key.to_string(), now_ms());
    }

    pub fn mark_ok(&mut self, key: &str) {
        self.fails.remove(key);
    }

    /// Falha leve (429/403/timeout): aumenta backoff e quarentena curta.
    pub fn mark_fail(&mut self, key: &str) -> i64 {
        let n = self.fails.get(key).copied().unwrap_or(0) + 1;
        self.fails.insert(key.to_string(), n);
        // 2min, 8min, 20min, 40min... capa em 60min
        let mins: i64 = match n {
            1 => 2,
            2 => 8,
            3 => 20,
            _ => 60,
        };
        let until = now_ms() + mins * 60_000;
        self.quarantine_until_ms.insert(key.to_string(), until);
        mins
    }

    /// Verificacao dura (telefone/rosto/bloqueio): quarentena longa 24h.
    pub fn mark_hard_lock(&mut self, key: &str) {
        self.fails.insert(key.to_string(), 99);
        self.quarantine_until_ms
            .insert(key.to_string(), now_ms() + 24 * 60 * 60_000);
    }

    pub fn is_quarantined(&self, key: &str) -> bool {
        self.quarantine_until_ms
            .get(key)
            .is_some_and(|until| now_ms() < *until)
    }
}
