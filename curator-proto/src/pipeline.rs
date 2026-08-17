use crate::contracts::DevicePreference;
use std::collections::HashMap;
use std::sync::Arc;

/// A typed I/O port descriptor for node metadata.
pub struct Port {
    pub name: &'static str,
    pub type_name: &'static str,
}

/// Metadata about a system node for registration, UI display, and pipeline wiring.
pub struct NodeInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub inputs: Vec<Port>,
    pub outputs: Vec<Port>,
}

/// Core trait for in-process system nodes.
///
/// Each node wraps one or more ONNX sessions and exposes its own typed
/// execution methods (e.g., `generate_image_embedding`, `tag_image`).
/// This trait provides the common lifecycle interface for the orchestrator
/// to manage devices and sessions uniformly.
pub trait SystemNode: Send + Sync {
    /// Node identity and port metadata.
    fn info(&self) -> NodeInfo;

    /// Current device preference.
    fn device(&self) -> DevicePreference;

    /// Switch device preference (unloads sessions for reload on next call).
    fn set_device(&self, device: DevicePreference);

    /// Unload all ONNX sessions held by this node.
    fn unload_all(&self);

    /// Whether all required sessions are loaded.
    fn is_loaded(&self) -> bool;
}

/// Central registry of all system nodes.
/// Provides uniform device management and node enumeration.
pub struct NodeRegistry {
    nodes: HashMap<&'static str, Arc<dyn SystemNode>>,
}

impl NodeRegistry {
    pub fn new() -> Self {
        Self {
            nodes: HashMap::new(),
        }
    }

    /// Register a system node. Overwrites if ID already exists.
    pub fn register(&mut self, node: Arc<dyn SystemNode>) {
        let info = node.info();
        self.nodes.insert(info.id, node);
    }

    /// Look up a node by ID.
    pub fn get(&self, id: &str) -> Option<Arc<dyn SystemNode>> {
        self.nodes.get(id).cloned()
    }

    /// Iterate all registered nodes.
    pub fn iter(&self) -> impl Iterator<Item = (&'static str, Arc<dyn SystemNode>)> {
        self.nodes.iter().map(|(&id, node)| (id, node.clone()))
    }

    /// Set device preference on all registered nodes (global GPU/CPU switch).
    pub fn set_all_devices(&self, device: DevicePreference) {
        for node in self.nodes.values() {
            node.set_device(device.clone());
        }
    }

    /// Unload all sessions across all nodes (memory pressure response).
    pub fn unload_all(&self) {
        for node in self.nodes.values() {
            node.unload_all();
        }
    }

    /// Get summary info for all registered nodes (for settings UI).
    pub fn list_nodes(&self) -> Vec<NodeInfo> {
        self.nodes.values().map(|n| n.info()).collect()
    }

    /// Number of registered nodes.
    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    /// Whether the registry is empty.
    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }
}

impl Default for NodeRegistry {
    fn default() -> Self {
        Self::new()
    }
}
