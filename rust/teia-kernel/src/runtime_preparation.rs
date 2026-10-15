// Shared off-render resource preparation. Exported to WASM and used within
// the owned native scope; no separate native scheduler or resource allocator.

/// Opt-in finite repeat policy for the compiled graph's context zero. Zero is
/// deliberately not a default: legacy patches retain their dynamic semantics.
/// Returns -1 for invalid budgets, active repeats or excess requested memory.
#[no_mangle]
pub extern "C" fn prepareDspRealtime(repeat_capacity: u32, budget_bytes: u32) -> i32 {
    let capacity = repeat_capacity as usize;
    if capacity == 0 || capacity > 1024 { return -1; }
    unsafe {
        let mut layouts = Vec::new();
        let mut bytes = 0usize;
        for index in 0..kernel_global!(DSP_OP_COUNT) {
            let op = kernel_global!(DSP_OPS)[index];
            if !matches!(op.opcode, DSP_OP_SPREAD_BEGIN | DSP_OP_SPAWN_BEGIN) { continue; }
            let slot = op.value as usize;
            if slot >= MAX_DSP_SPREADS || op.b < 0 || op.b as usize >= kernel_global!(DSP_OP_COUNT) { return -1; }
            if kernel_global!(DSP_SPREAD_RUNTIMES)[slot].as_ref().is_some_and(|r| r.states_by_context.iter().any(|v| !v.is_empty()))
                || kernel_global!(DSP_SPAWN_RUNTIMES)[slot].as_ref().is_some_and(|r| r.instances_by_context.iter().any(|v| !v.is_empty())) { return -1; }
            let layout = dsp_template_resource_layout(index, op.b as usize);
            let per_item = layout.state_count.saturating_mul(8)
                .saturating_add(layout.sample_indices.len().saturating_mul(std::mem::size_of::<DspSamplePlaybackState>()))
                .saturating_add(layout.effect_slots.len().saturating_mul(MAX_DSP_DELAY_SAMPLES * 4))
                .saturating_add(layout.buffer_slots.len().saturating_mul(MAX_DSP_BUFFER_SAMPLES * 4))
                .saturating_add(std::mem::size_of::<DspSpawnInstance>() + 256);
            bytes = bytes.saturating_add(per_item.saturating_mul(capacity));
            if bytes > budget_bytes as usize { return -1; }
            layouts.push((op.opcode, slot, layout));
        }
        let seed = kernel_global!(DSP_RANDOM_SEED_STREAM);
        for (opcode, slot, layout) in layouts {
            if opcode == DSP_OP_SPAWN_BEGIN {
                let mut runtime = DspSpawnRuntime::new();
                runtime.instances_by_context[0] = Vec::with_capacity(capacity);
                runtime.free_instances_by_context[0] = (0..capacity).map(|_| DspSpawnInstance {
                    states: vec![0.0; layout.state_count], resources: DspRepeatResourceState::new(&layout),
                    tag: 0.0, gate: false, kill_triggered: false,
                }).collect();
                if runtime.free_instances_by_context[0].iter().any(|i| !i.resources.is_prepared()) {
                    kernel_global!(DSP_RANDOM_SEED_STREAM) = seed;
                    return -1;
                }
                runtime.resource_layout = Some(layout);
                kernel_global!(DSP_SPAWN_RUNTIMES)[slot] = Some(runtime);
            } else {
                let mut runtime = DspSpreadRuntime::new();
                runtime.states_by_context[0] = Vec::with_capacity(capacity.saturating_mul(layout.state_count));
                runtime.resources_by_context[0] = Vec::with_capacity(capacity);
                runtime.spare_resources_by_context[0] = (0..capacity).map(|_| DspRepeatResourceState::new(&layout)).collect();
                if runtime.spare_resources_by_context[0].iter().any(|r| !r.is_prepared()) {
                    kernel_global!(DSP_RANDOM_SEED_STREAM) = seed;
                    return -1;
                }
                runtime.resource_layout = Some(layout);
                kernel_global!(DSP_SPREAD_RUNTIMES)[slot] = Some(runtime);
            }
        }
        // Pool construction must not consume the patch's audible random stream.
        kernel_global!(DSP_RANDOM_SEED_STREAM) = seed;
        kernel_global!(DSP_REPEAT_CAPACITY) = capacity;
        kernel_global!(DSP_REPEAT_EXHAUSTIONS) = 0;
    }
    1
}

#[no_mangle]
pub extern "C" fn dspRepeatExhaustions() -> f64 { unsafe { kernel_global!(DSP_REPEAT_EXHAUSTIONS) as f64 } }
