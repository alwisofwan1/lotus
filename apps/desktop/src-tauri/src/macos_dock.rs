use std::{error::Error, ffi::CStr, mem, sync::OnceLock};

use objc2::{
    rc::Retained,
    runtime::{AnyClass, AnyObject, Bool, Imp, Sel},
    sel, MainThreadMarker, MainThreadOnly,
};
use objc2_app_kit::{NSApp, NSApplication, NSMenu, NSMenuItem};
use objc2_foundation::ns_string;
use tauri::AppHandle;

use crate::windowing;

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
const DOCK_MENU_TITLE: &str = "Lotus";
const NEW_WINDOW_ITEM_TITLE: &str = "New Window";

// Dock menu support is installed by patching the Tao app delegate class that
// Tauri already uses on macOS. This keeps Lotus aligned with Tao's lifecycle
// instead of replacing the delegate outright.

pub fn install(app: AppHandle) -> Result<(), Box<dyn Error>> {
    APP_HANDLE.get_or_init(|| app.clone());

    app.run_on_main_thread(move || {
        let mtm = MainThreadMarker::new().expect("Dock integration must run on the main thread");
        let ns_app = NSApp(mtm);

        let Some(delegate) = ns_app.delegate() else {
            log_dock_warning("install skipped", "NSApplication delegate not available");
            return;
        };

        let delegate_obj: &AnyObject = delegate.as_ref();
        let delegate_class = delegate_obj.class();
        unsafe {
            if let Err(err) = add_method_if_missing(
                delegate_class,
                sel!(applicationDockMenu:),
                mem::transmute::<
                    extern "C" fn(&AnyObject, Sel, &NSApplication) -> *mut NSMenu,
                    Imp,
                >(application_dock_menu),
                c"@@:@",
            ) {
                log_dock_warning("failed to install Dock menu handler", &err);
            }

            if let Err(err) = add_method_if_missing(
                delegate_class,
                sel!(lotusOpenNewWindowFromDock:),
                mem::transmute::<extern "C" fn(&AnyObject, Sel, &AnyObject), Imp>(
                    open_new_window_from_dock,
                ),
                c"v@:@",
            ) {
                log_dock_warning("failed to install Dock menu action", &err);
            }

            // ⌘Q, Dock › Quit and logout reach Lotus only here: Tauri raises no ExitRequested
            // for them, and the final Exit can no longer say no (`quit_guard.rs`).
            if let Err(err) = add_method_if_missing(
                delegate_class,
                sel!(applicationShouldTerminate:),
                mem::transmute::<extern "C" fn(&AnyObject, Sel, &NSApplication) -> usize, Imp>(
                    application_should_terminate,
                ),
                c"Q@:@",
            ) {
                log_dock_warning("failed to install the quit guard", &err);
            }
        }

        ns_app.dockTile().display();
    })?;

    Ok(())
}

unsafe fn add_method_if_missing(
    class: &AnyClass,
    selector: Sel,
    implementation: Imp,
    type_encoding: &CStr,
) -> Result<(), String> {
    if class.responds_to(selector) {
        return Ok(());
    }

    let success = unsafe {
        objc2::ffi::class_addMethod(
            class as *const _ as *mut _,
            selector,
            implementation,
            type_encoding.as_ptr(),
        )
    };

    if success == Bool::YES {
        Ok(())
    } else {
        Err(format!(
            "Objective-C runtime rejected selector {} on {}",
            selector,
            class.name().to_string_lossy()
        ))
    }
}

extern "C" fn application_dock_menu(this: &AnyObject, _: Sel, _: &NSApplication) -> *mut NSMenu {
    let mtm = MainThreadMarker::new().expect("Dock menu callback must run on the main thread");
    let menu = NSMenu::initWithTitle(NSMenu::alloc(mtm), ns_string!(DOCK_MENU_TITLE));
    let item = unsafe {
        NSMenuItem::initWithTitle_action_keyEquivalent(
            NSMenuItem::alloc(mtm),
            ns_string!(NEW_WINDOW_ITEM_TITLE),
            Some(sel!(lotusOpenNewWindowFromDock:)),
            ns_string!(""),
        )
    };

    unsafe {
        item.setTarget(Some(this));
    }
    menu.addItem(&item);

    Retained::autorelease_return(menu)
}

extern "C" fn open_new_window_from_dock(_: &AnyObject, _: Sel, _: &AnyObject) {
    let Some(app) = APP_HANDLE.get() else {
        log_dock_warning(
            "failed to create Lotus window from Dock",
            "missing AppHandle",
        );
        return;
    };

    if let Err(err) = windowing::create_app_window(app, None) {
        log_dock_warning("failed to create Lotus window from Dock", &err.to_string());
    }
}

/// NSTerminateNow = 1, NSTerminateCancel = 0.
extern "C" fn application_should_terminate(_: &AnyObject, _: Sel, _: &NSApplication) -> usize {
    let Some(app) = APP_HANDLE.get() else {
        return 1;
    };
    let reason = system_quit_reason();
    usize::from(crate::quit_guard::should_terminate(app, reason))
}

/// The quit reason (`kAEQuitReason`, 'why?') of the Apple event behind this quit: present for
/// logout, restart and shutdown; absent for ⌘Q (no event) and Dock › Quit ('aevt'/'quit' alone).
fn system_quit_reason() -> Option<String> {
    use objc2::{class, msg_send};
    let why = u32::from_be_bytes(*b"why?");
    unsafe {
        let mgr: *mut AnyObject = msg_send![class!(NSAppleEventManager), sharedAppleEventManager];
        if mgr.is_null() {
            return None;
        }
        let event: *mut AnyObject = msg_send![mgr, currentAppleEvent];
        if event.is_null() {
            return None;
        }
        let mut desc: *mut AnyObject = msg_send![event, attributeDescriptorForKeyword: why];
        if desc.is_null() {
            desc = msg_send![event, paramDescriptorForKeyword: why];
        }
        if desc.is_null() {
            return None;
        }
        let code: u32 = msg_send![desc, enumCodeValue];
        Some(String::from_utf8_lossy(&code.to_be_bytes()).into_owned())
    }
}

fn log_dock_warning(context: &str, detail: &str) {
    eprintln!("Lotus Dock menu {context}: {detail}");
}
