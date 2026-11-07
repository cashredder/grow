//! NEP-297 events. The API's indexer reads these; their names and fields are the contract's public interface
//! (`api/src/indexer/events.ts` parses them).
use near_sdk::env;
use near_sdk::serde_json::{json, Value};

pub const STANDARD: &str = "grow";
pub const VERSION: &str = "1.0.0";

pub fn emit(event: &str, data: Value) {
    let body = json!({ "standard": STANDARD, "version": VERSION, "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{body}"));
}

/// u128 as a decimal string, as NEP-297 consumers expect.
pub fn s(v: u128) -> String {
    v.to_string()
}
