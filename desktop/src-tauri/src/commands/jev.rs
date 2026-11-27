#[tauri::command]
pub async fn jev_decide(body: String) -> Result<String, String> {
    let _ = body;
    Err("jev_unavailable".into())
}

#[tauri::command]
pub async fn jev_key_status() -> Result<bool, String> {
    Ok(false)
}

#[tauri::command]
pub async fn jev_key_set(key: String) -> Result<(), String> {
    let _ = key;
    Err("jev_unavailable".into())
}

#[tauri::command]
pub async fn jev_key_delete() -> Result<(), String> {
    Ok(())
}
