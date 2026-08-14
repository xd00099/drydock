//! Wake-from-sleep detection.
//!
//! After a long lid-close, the webview wakes compositing purged GPU surfaces:
//! stale layer tiles, dead WebGL contexts. Neither WebKit helper process dies
//! (verified against two-week-old helpers), so wry's WebContent-termination
//! reload never fires — recovery has to be triggered by us. This module only
//! *detects* the wake and emits `system-woke`; the repaint sweep lives in the
//! frontend (src/lib/wake.ts), which owns the terminals and their contexts.
//!
//! `NSWorkspaceDidWakeNotification` covers system sleep; `ScreensDidWake`
//! covers display-only sleep, where long idles can still evict GPU state.
//! The frontend coalesces the pair (they often arrive together).

#[cfg(target_os = "macos")]
pub fn watch(app: tauri::AppHandle) {
    use block2::RcBlock;
    use objc2_app_kit::{
        NSWorkspace, NSWorkspaceDidWakeNotification, NSWorkspaceScreensDidWakeNotification,
    };
    use objc2_foundation::NSNotification;
    use std::ptr::NonNull;
    use tauri::Emitter;

    // SAFETY: the shared workspace, its notification center, and the static
    // notification names all outlive the process. The observer tokens are
    // deliberately leaked: the subscription is app-lifetime, and dropping a
    // token would unregister it.
    unsafe {
        let center = NSWorkspace::sharedWorkspace().notificationCenter();
        for name in [
            NSWorkspaceDidWakeNotification,
            NSWorkspaceScreensDidWakeNotification,
        ] {
            let app = app.clone();
            let block = RcBlock::new(move |_: NonNull<NSNotification>| {
                let _ = app.emit("system-woke", ());
            });
            let token =
                center.addObserverForName_object_queue_usingBlock(Some(name), None, None, &block);
            std::mem::forget(token);
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn watch(_app: tauri::AppHandle) {}
