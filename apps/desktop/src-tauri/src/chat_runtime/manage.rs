//! The rail, run by an agent when the user asks (`lotus_chat_list`, `lotus_chat_manage`): find
//! chats, then archive, pin, rename or delete them — the same actions as the rail's menu (#291).

use serde::Deserialize;
use serde_json::{json, Value};

use super::store::ThreadRecord;
use super::ChatRuntime;

#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ManageAction {
    Archive,
    Unarchive,
    Pin,
    Unpin,
    Rename,
    Delete,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManageRequest {
    /// The chat whose agent asks (`LOTUS_CHAT_THREAD_ID`); None outside a Lotus chat.
    #[serde(default)]
    pub caller_id: Option<String>,
    pub action: ManageAction,
    pub chat_ids: Vec<String>,
    /// The new name, for `rename`; empty goes back to the first message's line.
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ListRequest {
    /// "active" (default), "archived" or "all".
    #[serde(default)]
    pub archived: Option<String>,
    /// Matched against the title and the folder, case-insensitively.
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
}

impl ChatRuntime {
    pub fn list_for_agent(&self, req: &ListRequest) -> Result<Value, String> {
        let threads = self.list_threads()?;
        let chats = filter_threads(&threads, req)?;
        Ok(json!({ "total": chats.len(), "chats": chats.iter().take(req.limit.unwrap_or(50).clamp(1, 200)).map(|t| summary(t)).collect::<Vec<_>>() }))
    }

    /// Each id is tried on its own: one failure does not undo or stop the others.
    pub async fn manage_threads(&self, req: ManageRequest) -> Result<Value, String> {
        let threads = self.list_threads()?;
        check_manage(&threads, &req)?;
        let mut done = Vec::new();
        let mut failed = Vec::new();
        for id in &req.chat_ids {
            let title = threads.iter().find(|t| &t.id == id).and_then(|t| t.title.clone());
            let result = match req.action {
                ManageAction::Archive => self.archive_thread(id, true).await,
                ManageAction::Unarchive => self.archive_thread(id, false).await,
                ManageAction::Pin => self.pin_thread(id, true),
                ManageAction::Unpin => self.pin_thread(id, false),
                ManageAction::Rename => self.rename_thread(id, req.title.as_deref().unwrap_or("")),
                ManageAction::Delete => self.delete_thread(id).await,
            };
            match result {
                Ok(()) => done.push(json!({ "chatId": id, "title": title })),
                Err(error) => failed.push(json!({ "chatId": id, "title": title, "error": error })),
            }
        }
        if !done.is_empty() {
            self.rail_changed();
        }
        Ok(json!({ "action": req.action_name(), "done": done, "failed": failed }))
    }
}

impl ManageRequest {
    fn action_name(&self) -> &'static str {
        match self.action {
            ManageAction::Archive => "archive",
            ManageAction::Unarchive => "unarchive",
            ManageAction::Pin => "pin",
            ManageAction::Unpin => "unpin",
            ManageAction::Rename => "rename",
            ManageAction::Delete => "delete",
        }
    }
}

fn summary(t: &ThreadRecord) -> Value {
    json!({
        "chatId": t.id,
        "title": t.title,
        "cwd": t.cwd,
        "runner": t.runner,
        "archived": t.archived,
        "pinned": t.pinned_at.is_some(),
        "status": t.status.unwrap_or("idle"),
        "parentId": t.parent_id,
        "updatedAt": t.updated_at,
    })
}

fn filter_threads<'a>(threads: &'a [ThreadRecord], req: &ListRequest) -> Result<Vec<&'a ThreadRecord>, String> {
    let archived = match req.archived.as_deref().unwrap_or("active") {
        "active" => Some(false),
        "archived" => Some(true),
        "all" => None,
        other => return Err(format!("archived must be active, archived or all, not {other:?}")),
    };
    let query = req.query.as_deref().map(str::trim).filter(|q| !q.is_empty()).map(str::to_lowercase);
    Ok(threads
        .iter()
        .filter(|t| archived.is_none_or(|a| t.archived == a))
        .filter(|t| {
            query.as_ref().is_none_or(|q| {
                t.title.as_deref().unwrap_or("").to_lowercase().contains(q) || t.cwd.to_lowercase().contains(q)
            })
        })
        .collect())
}

/// Refused before anything changes: an unknown id (a typo must not half-apply), a rename without
/// exactly one chat, and an agent deleting the chat it is answering in.
fn check_manage(threads: &[ThreadRecord], req: &ManageRequest) -> Result<(), String> {
    if req.chat_ids.is_empty() {
        return Err("no chatIds given".into());
    }
    let unknown: Vec<&str> = req.chat_ids.iter().filter(|id| !threads.iter().any(|t| &t.id == *id)).map(String::as_str).collect();
    if !unknown.is_empty() {
        return Err(format!("no chat with id {} · list them with lotus_chat_list", unknown.join(", ")));
    }
    if req.action == ManageAction::Rename && (req.chat_ids.len() != 1 || req.title.is_none()) {
        return Err("rename takes exactly one chatId and a title".into());
    }
    if req.action == ManageAction::Delete && req.caller_id.as_ref().is_some_and(|me| req.chat_ids.contains(me)) {
        return Err("a chat cannot delete itself while it answers · ask the user to delete it from the rail".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn thread(id: &str, title: &str, cwd: &str, archived: bool) -> ThreadRecord {
        ThreadRecord {
            id: id.into(),
            cwd: cwd.into(),
            model: None,
            permission_mode: "default".into(),
            runner: "claude".into(),
            provider: None,
            effort: None,
            provider_session_id: None,
            account: None,
            created_at: 0,
            updated_at: 0,
            title: Some(title.into()),
            imported_from: None,
            archived,
            pinned_at: None,
            last_turn_ended_at: None,
            last_read_at: None,
            turn_started_at: None,
            status: None,
            link: None,
            parent_id: None,
            machine: None,
            agent_name: None,
        }
    }

    fn manage(action: ManageAction, ids: &[&str], caller: Option<&str>, title: Option<&str>) -> ManageRequest {
        ManageRequest {
            caller_id: caller.map(str::to_string),
            action,
            chat_ids: ids.iter().map(|s| s.to_string()).collect(),
            title: title.map(str::to_string),
        }
    }

    #[test]
    fn refuses_before_changing_anything() {
        let threads = vec![thread("a", "Release notes", "/w/lotus", false), thread("b", "Sign-in", "/w/bb", false)];
        assert!(check_manage(&threads, &manage(ManageAction::Archive, &["a", "b"], None, None)).is_ok());
        assert!(check_manage(&threads, &manage(ManageAction::Archive, &["a", "zz"], None, None)).unwrap_err().contains("zz"));
        assert!(check_manage(&threads, &manage(ManageAction::Archive, &[], None, None)).is_err());
        assert!(check_manage(&threads, &manage(ManageAction::Rename, &["a", "b"], None, Some("x"))).is_err());
        assert!(check_manage(&threads, &manage(ManageAction::Rename, &["a"], None, None)).is_err());
        assert!(check_manage(&threads, &manage(ManageAction::Rename, &["a"], None, Some("x"))).is_ok());
        assert!(check_manage(&threads, &manage(ManageAction::Delete, &["a", "b"], Some("b"), None)).unwrap_err().contains("itself"));
        // Archiving its own chat is fine: a running chat is not stopped by it.
        assert!(check_manage(&threads, &manage(ManageAction::Archive, &["b"], Some("b"), None)).is_ok());
    }

    #[test]
    fn lists_active_by_default_and_matches_title_or_folder() {
        let threads = vec![thread("a", "Release notes", "/w/lotus", false), thread("b", "Old", "/w/bb", true)];
        let ids = |req: ListRequest| filter_threads(&threads, &req).unwrap().iter().map(|t| t.id.clone()).collect::<Vec<_>>();
        assert_eq!(ids(ListRequest::default()), ["a"]);
        assert_eq!(ids(ListRequest { archived: Some("all".into()), ..Default::default() }), ["a", "b"]);
        assert_eq!(ids(ListRequest { archived: Some("archived".into()), ..Default::default() }), ["b"]);
        assert_eq!(ids(ListRequest { query: Some("RELEASE".into()), ..Default::default() }), ["a"]);
        assert_eq!(ids(ListRequest { archived: Some("all".into()), query: Some("/w/bb".into()), ..Default::default() }), ["b"]);
        assert!(filter_threads(&threads, &ListRequest { archived: Some("x".into()), ..Default::default() }).is_err());
    }
}
