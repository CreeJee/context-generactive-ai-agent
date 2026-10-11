//! Use the hosting Node process's SQLite API and POSIX lock bookkeeping.
//! Linking a second SQLite into this process can truncate a live WAL SHM mapping.
#[cfg(all(feature = "node-sqlite", feature = "test-sqlite"))]
compile_error!("Node SQLite and test-only bundled SQLite must not be combined");
#[cfg(all(feature = "test-sqlite", not(test)))]
compile_error!("bundled SQLite is permitted only in the Rust unit-test executable");

#[cfg(feature = "node-sqlite")]
static INITIALIZED: std::sync::OnceLock<i32> = std::sync::OnceLock::new();

/// SQLite invokes this entry point on a trusted, temporary Node-owned connection.
/// The API table and extension code stay resident for the process lifetime.
/// # Safety
/// `db`, `error` and `api` must come directly from sqlite3_load_extension.
#[cfg(feature = "node-sqlite")]
#[no_mangle]
pub unsafe extern "C" fn sqlite3_turbovec_init(
    db: *mut rusqlite::ffi::sqlite3,
    error: *mut *mut std::ffi::c_char,
    api: *mut rusqlite::ffi::sqlite3_api_routines,
) -> i32 {
    *INITIALIZED.get_or_init(|| {
        // SAFETY: SQLite supplies its ABI table; we register no SQL functions or database effects.
        unsafe { rusqlite::Connection::extension_init2(db, error, api, |_| Ok(true)) }
    })
}

#[cfg(feature = "node-sqlite")]
pub fn ensure_initialized() -> napi::Result<()> {
    if INITIALIZED.get() == Some(&rusqlite::ffi::SQLITE_OK_LOAD_PERMANENTLY) {
        return Ok(());
    }
    Err(napi::Error::from_reason("Node SQLite bridge is not initialized"))
}

#[cfg(all(test, feature = "test-sqlite"))]
pub fn ensure_initialized() -> napi::Result<()> {
    Ok(())
}
