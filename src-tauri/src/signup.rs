// Manual account creation ("Create account manually" in the Generator tab).
//
// Opens the OFFICIAL Roblox signup page in an incognito WebviewWindow and
// autofills the credentials generated in the renderer (username + password)
// plus a random birthday that is generated right here, at autofill time --
// never shown in the generator UI. The user still completes the CAPTCHA and
// submits the form themselves; nothing else is automated.
//
// Once Roblox logs the new account in (it does so automatically after a
// successful signup), the .ROBLOSECURITY cookie is captured exactly like the
// login flow does, so the account can be dropped straight into the existing
// accounts list via the same add-account path.
//
// This mirrors the signup autofill that existed in the old
// roblox-account-manager (roblox-signup-autofill.js), adapted to Tauri's
// WebviewWindow + eval() instead of Electron's executeJavaScript().

use crate::state::AppState;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::AppHandle;
use url::Url;

pub struct SignupResult {
    pub success: bool,
    pub cookie: Option<String>,
    pub username: Option<String>,
    pub user_id: Option<String>,
    pub closed: bool,
    pub error: Option<String>,
}

const MONTH_NAMES: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const MONTH_NAMES_FULL: [&str; 12] = [
    "January", "February", "March", "April", "May", "June", "July", "August", "September",
    "October", "November", "December",
];

fn days_in_month(month: u32, year: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
            if leap { 29 } else { 28 }
        }
        _ => 30,
    }
}

// Random birthday, always a real date: year in [1995, 2007] (inclusive) and a
// day valid for the picked month (handles Feb 29 on leap years). Generated
// once per signup attempt, at autofill time.
fn random_birthday() -> (u32, u32, u32) {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let month = rng.gen_range(1..=12);
    let year = rng.gen_range(1995..=2007);
    let day = rng.gen_range(1..=days_in_month(month, year));
    (month, day, year)
}

fn js_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

// Values are baked in as fixed strings so re-injecting the script (for slow
// page loads) is idempotent and never changes the generated data.
const AUTOFILL_TEMPLATE: &str = r#"(function () {
  if (window.__mrSignupAutofillInjected) return;
  window.__mrSignupAutofillInjected = true;

  var creds = {
    username: "@@USER@@",
    password: "@@PASS@@",
    birthday: {
      month: "@@MONTH@@",
      monthFull: "@@MONTH_FULL@@",
      monthIndex: @@MONTH_INDEX@@,
      day: "@@DAY@@",
      dayPadded: "@@DAY_PADDED@@",
      dayIndex: @@DAY_INDEX@@,
      year: "@@YEAR@@"
    }
  };

  function setNativeValue(el, value) {
    if (!el || value == null || value === '') return false;
    var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  }

  function fireReactChange(el) {
    for (var ki = 0; ki < Object.keys(el).length; ki += 1) {
      var key = Object.keys(el)[ki];
      if (key.indexOf('reactProps') !== -1 || key.indexOf('reactEventHandlers') !== -1) {
        var props = el[key];
        if (props && typeof props.onChange === 'function') {
          props.onChange({ target: el, currentTarget: el });
          return true;
        }
      }
    }
    var fiberKey = Object.keys(el).find(function (k) {
      return k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0;
    });
    if (fiberKey) {
      var fiber = el[fiberKey];
      while (fiber) {
        if (fiber.memoizedProps && typeof fiber.memoizedProps.onChange === 'function') {
          fiber.memoizedProps.onChange({ target: el, currentTarget: el });
          return true;
        }
        fiber = fiber.return;
      }
    }
    return false;
  }

  function setSelect(el, values, indexHint) {
    if (!el) return false;
    var candidates = Array.isArray(values) ? values : [values];
    var found = false;
    for (var ci = 0; ci < candidates.length && !found; ci += 1) {
      var wanted = String(candidates[ci]);
      for (var i = 0; i < el.options.length; i += 1) {
        var opt = el.options[i];
        if (opt.value === wanted || opt.text === wanted || String(opt.textContent || '').trim() === wanted) {
          el.selectedIndex = i;
          opt.selected = true;
          found = true;
          break;
        }
      }
    }
    if (!found && indexHint != null && el.options[indexHint]) {
      el.selectedIndex = indexHint;
      el.options[indexHint].selected = true;
      found = true;
    }
    if (!found) return false;
    fireReactChange(el);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function pickBirthday() {
    var monthEl = document.querySelector('#MonthDropdown');
    var dayEl = document.querySelector('#DayDropdown');
    var yearEl = document.querySelector('#YearDropdown');
    if (!monthEl || !dayEl || !yearEl || !creds.birthday) return false;
    var ok = true;
    ok = setSelect(monthEl, [creds.birthday.month, creds.birthday.monthFull], creds.birthday.monthIndex) && ok;
    ok = setSelect(dayEl, [creds.birthday.dayPadded, creds.birthday.day], creds.birthday.dayIndex) && ok;
    ok = setSelect(yearEl, [creds.birthday.year], null) && ok;
    return ok;
  }

  function tryFill() {
    var filled = 0;
    if (pickBirthday()) filled += 1;
    var usernameEl = document.querySelector('#signup-username') || document.querySelector('input[name="username"]');
    var passwordEl = document.querySelector('#signup-password') || document.querySelector('input[name="password"]');
    var confirmEl = document.querySelector('#signup-password-confirm') || document.querySelector('input[name="passwordConfirm"]') || document.querySelector('input[autocomplete="new-password"]:not(#signup-password)');
    if (setNativeValue(usernameEl, creds.username)) filled += 1;
    if (setNativeValue(passwordEl, creds.password)) filled += 1;
    if (creds.password && confirmEl && confirmEl !== passwordEl) setNativeValue(confirmEl, creds.password);
    return filled;
  }

  tryFill();
  var attempts = 0;
  var timer = setInterval(function () {
    attempts += 1;
    var filled = tryFill();
    if (filled >= 3 || attempts >= 60) clearInterval(timer);
  }, 500);
})();"#;

fn build_autofill_script(username: &str, password: &str, month: u32, day: u32, year: u32) -> String {
    let month_name = MONTH_NAMES[(month - 1) as usize];
    let month_full = MONTH_NAMES_FULL[(month - 1) as usize];
    AUTOFILL_TEMPLATE
        .replace("@@USER@@", &js_escape(username))
        .replace("@@PASS@@", &js_escape(password))
        .replace("@@MONTH@@", month_name)
        .replace("@@MONTH_FULL@@", month_full)
        .replace("@@MONTH_INDEX@@", &month.to_string())
        .replace("@@DAY@@", &day.to_string())
        .replace("@@DAY_PADDED@@", &format!("{:02}", day))
        .replace("@@DAY_INDEX@@", &day.to_string())
        .replace("@@YEAR@@", &year.to_string())
}

pub async fn open_signup_window(
    app: &AppHandle,
    state: &AppState,
    username: &str,
    password: &str,
) -> SignupResult {
    let label = format!("signup-{}", uuid::Uuid::new_v4().simple());
    let signup_url = match Url::parse("https://www.roblox.com/CreateAccount") {
        Ok(u) => u,
        Err(e) => {
            return SignupResult {
                success: false,
                cookie: None,
                username: None,
                user_id: None,
                closed: false,
                error: Some(e.to_string()),
            };
        }
    };

    // incognito: same reasoning as the login window -- a persistent cookie
    // store would silently reuse whichever account was already logged in.
    let window = match tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::External(signup_url))
        .title("Create Roblox account")
        .inner_size(560.0, 840.0)
        .resizable(true)
        .center()
        .incognito(true)
        .build()
    {
        Ok(w) => w,
        Err(e) => {
            return SignupResult {
                success: false,
                cookie: None,
                username: None,
                user_id: None,
                closed: false,
                error: Some(format!("Failed to open signup window: {}", e)),
            };
        }
    };

    // Random birthday generated HERE, at autofill time. Fixed values make the
    // re-injection below (slow loads) idempotent.
    let (month, day, year) = random_birthday();
    let script = build_autofill_script(username, password, month, day, year);
    let _ = window.eval(script.clone());
    {
        let w = window.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(4)).await;
            let _ = w.eval(script);
        });
    }

    let closed = Arc::new(AtomicBool::new(false));
    {
        let closed2 = closed.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                closed2.store(true, Ordering::SeqCst);
            }
        });
    }

    let result = async {
        let cookie_url = match Url::parse("https://www.roblox.com") {
            Ok(u) => u,
            Err(_) => {
                return SignupResult {
                    success: false,
                    cookie: None,
                    username: None,
                    user_id: None,
                    closed: false,
                    error: Some("Invalid cookie URL".into()),
                };
            }
        };

        let started = Instant::now();
        let timeout = Duration::from_secs(10 * 60);
        loop {
            if started.elapsed() >= timeout {
                return SignupResult {
                    success: false,
                    cookie: None,
                    username: None,
                    user_id: None,
                    closed: false,
                    error: Some(
                        "Timed out waiting for you to finish creating the account. If you did create \
                         it, add it via Add Account > Paste Cookie (copy the .ROBLOSECURITY value \
                         from the signup window)."
                            .into(),
                    ),
                };
            }
            if closed.load(Ordering::SeqCst) {
                return SignupResult {
                    success: false,
                    cookie: None,
                    username: None,
                    user_id: None,
                    closed: true,
                    error: None,
                };
            }
            tokio::time::sleep(Duration::from_millis(1200)).await;
            let found = window
                .cookies_for_url(cookie_url.clone())
                .ok()
                .and_then(|cookies| {
                    cookies
                        .into_iter()
                        .find(|c| c.name() == ".ROBLOSECURITY" && c.value().len() > 100)
                })
                .map(|c| c.value().to_string());
            if let Some(cookie_val) = found {
                let info = crate::roblox_api::fetch_user_info(state, &cookie_val).await;
                if !info.ok {
                    return SignupResult {
                        success: false,
                        cookie: None,
                        username: None,
                        user_id: None,
                        closed: false,
                        error: Some(
                            info.reason
                                .unwrap_or_else(|| "Could not verify the new account.".into()),
                        ),
                    };
                }
                return SignupResult {
                    success: true,
                    cookie: Some(cookie_val),
                    username: info.username,
                    user_id: info.user_id,
                    closed: false,
                    error: None,
                };
            }
        }
    }
    .await;
    let _ = window.destroy();
    result
}
