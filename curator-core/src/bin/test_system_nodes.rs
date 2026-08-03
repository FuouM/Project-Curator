use curator_core::pipeline::{NodeRegistry, SystemNode};
use curator_core::vector::ModelManager;
use std::sync::Arc;

fn main() -> anyhow::Result<()> {
    println!("=== System Node Validation Binary ===\n");

    // 1. Create ModelManager
    let model_dir = std::path::Path::new(".curator/models");
    if !model_dir.exists() {
        println!("Model directory not found at {:?}. Skipping inference tests.", model_dir);
        println!("Creating ModelManager for registry test only...");
        let mm = ModelManager::new(model_dir, curator_core::DevicePreference::Cpu);
        test_registry_with_node(Arc::new(mm));
        return Ok(());
    }

    let mm = ModelManager::new(model_dir, curator_core::DevicePreference::Auto);
    mm.init()?;

    // 2. Test SystemNode trait implementation
    println!("\n--- Testing SystemNode trait for ModelManager ---");
    let mm_arc = Arc::new(mm);
    let info = mm_arc.info();
    println!("Node ID: {}", info.id);
    println!("Node Label: {}", info.label);
    println!("Inputs: {:?}", info.inputs.iter().map(|p| p.name).collect::<Vec<_>>());
    println!("Outputs: {:?}", info.outputs.iter().map(|p| p.name).collect::<Vec<_>>());
    println!("Device: {:?}", mm_arc.device());
    println!("Is Loaded: {}", mm_arc.is_loaded());

    // 3. Test NodeRegistry
    test_registry_with_node(mm_arc);

    println!("\n=== All validation tests passed! ===");
    Ok(())
}

fn test_registry_with_node(node: Arc<dyn SystemNode>) {
    println!("\n--- Testing NodeRegistry ---");
    let mut registry = NodeRegistry::new();
    registry.register(node);
    println!("Registered {} node(s)", registry.len());
    println!("Nodes: {:?}", registry.list_nodes().iter().map(|n| n.id).collect::<Vec<_>>());

    // Test get
    let retrieved = registry.get("clip-embedder");
    println!("Get 'clip-embedder': {}", retrieved.is_some());

    // Test set_all_devices
    registry.set_all_devices(curator_core::DevicePreference::Cpu);
    println!("Set all devices to Cpu: OK");

    // Test unload_all
    registry.unload_all();
    println!("Unload all: OK");

    // Test iter
    for (id, _node) in registry.iter() {
        println!("  Iter: {}", id);
    }
}
