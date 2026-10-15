//! Test runner for scripts/check-shared-runtime.mjs; never opens audio devices.
use std::io::{self, Read, Write};
use teia_kernel::hosted::*;
include!("support/source_stamp.rs");
fn main() {
    let mut text = String::new();
    io::stdin().read_to_string(&mut text).unwrap();
    let mut tokens = text.split_whitespace();
    let mut next = || tokens.next().unwrap().parse::<f64>().unwrap();
    let cases = next() as usize;
    let input: Vec<f32> = (0..128).map(|_| next() as f32).collect();
    let mut stamp = 0xcbf29ce484222325_u64;
    for (name, bytes) in SOURCES {
        for byte in name
            .as_bytes()
            .iter()
            .chain(std::iter::once(&0))
            .chain(bytes.iter())
        {
            stamp ^= *byte as u64;
            stamp = stamp.wrapping_mul(0x100000001b3);
        }
    }
    let mut result = stamp.to_le_bytes().to_vec();
    for _ in 0..cases {
        let value_count = next() as usize;
        let op_count = next() as usize;
        let values: Vec<f64> = (0..value_count).map(|_| next()).collect();
        let ops: Vec<Operation> = (0..op_count)
            .map(|_| Operation {
                opcode: next() as i32,
                out: next() as i32,
                a: next() as i32,
                b: next() as i32,
                c: next() as i32,
                d: next() as i32,
                e: next() as i32,
                state: next() as i32,
                value: next(),
                value2: next(),
                value3: next(),
                value4: next(),
            })
            .collect();
        let prepared = PreparedProgram::prepare(1, 1, &ops, &values).unwrap();
        let resources = Resources {
            repeat_capacity: Some(8),
            repeat_memory_budget: 64 * 1024 * 1024,
            ..Resources::default()
        };
        let mut instance =
            Instance::new_with_resources(&prepared, 48000.0, 128, &resources).unwrap();
        instance.set_control_smoothing(true);
        for block in 0..6 {
            let mut left = [0.0; 128];
            let mut right = [0.0; 128];
            let controls = if block == 2 && !values.is_empty() {
                vec![ControlEvent {
                    offset: 0,
                    value_index: 0,
                    value: values[0] * 0.5 + 0.1,
                    generation: 1,
                }]
            } else {
                vec![]
            };
            instance
                .process([&input, &input], [&mut left, &mut right], &controls)
                .unwrap();
            for channel in [&left, &right] {
                for sample in channel {
                    result.extend_from_slice(&sample.to_le_bytes());
                }
            }
            if block == 3 {
                instance.reset();
            }
        }
    }
    io::stdout().write_all(&result).unwrap();
}
