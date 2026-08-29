#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use std::{future::Future, pin::Pin};

pub type ConnectorFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'a>>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceEntry {
    pub source: String,
    pub relative_path: String,
    pub remote_id: Option<String>,
    pub version: Option<String>,
    pub modified_at: u64,
    pub fingerprint: Option<String>,
}

pub trait FileSource: Send + Sync {
    fn id(&self) -> &'static str;
    fn list<'a>(&'a self, path: &'a str) -> ConnectorFuture<'a, Vec<SourceEntry>>;
    fn download<'a>(&'a self, entry: &'a SourceEntry) -> ConnectorFuture<'a, Vec<u8>>;
    fn upload<'a>(&'a self, path: &'a str, content: Vec<u8>) -> ConnectorFuture<'a, SourceEntry>;
}

pub trait ModelProvider: Send + Sync {
    fn id(&self) -> &'static str;
    fn complete<'a>(&'a self, task_type: &'a str, content: &'a str) -> ConnectorFuture<'a, String>;
}

pub trait NotificationProvider: Send + Sync {
    fn id(&self) -> &'static str;
    fn notify<'a>(&'a self, title: &'a str, body: &'a str) -> ConnectorFuture<'a, ()>;
}

pub trait OcrProvider: Send + Sync {
    fn id(&self) -> &'static str;
    fn recognize<'a>(&'a self, content: Vec<u8>, mime: &'a str) -> ConnectorFuture<'a, String>;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncBinding {
    pub id: String,
    pub local_path: String,
    pub provider: String,
    pub drive_id: Option<String>,
    pub remote_file_id: Option<String>,
    pub direction: String,
    pub schedule: Option<String>,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessPolicy {
    pub device_id: String,
    pub file_access: String,
    pub planner_write: bool,
    pub expires_at: Option<u64>,
}
