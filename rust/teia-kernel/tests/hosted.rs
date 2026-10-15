//! Functional tests: compile with cargo check --tests; execute only with authorization.
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use teia_kernel::hosted::*;
thread_local! { static WATCH: Cell<bool> = const { Cell::new(false) }; static CHANGES: Cell<usize> = const { Cell::new(0) }; }
struct CountingAllocator;
unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let _ = WATCH.try_with(|watch| {
            if watch.get() {
                CHANGES.with(|n| n.set(n.get() + 1));
            }
        });
        System.alloc(layout)
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        let _ = WATCH.try_with(|watch| {
            if watch.get() {
                CHANGES.with(|n| n.set(n.get() + 1));
            }
        });
        System.dealloc(ptr, layout)
    }
}
#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;
fn op(opcode: i32, out: i32, a: i32, b: i32) -> Operation {
    Operation {
        opcode,
        out,
        a,
        b,
        c: -1,
        d: -1,
        e: -1,
        state: -1,
        value: 0.0,
        value2: 0.0,
        value3: 0.0,
        value4: 0.0,
    }
}
fn stereo() -> PreparedProgram {
    PreparedProgram::prepare(
        1,
        7,
        &[
            op(0, 0, 0, -1),
            op(11, 1, 0, 0),
            op(11, 2, 0, 1),
            op(5, -1, 1, 0),
            op(5, -1, 2, 1),
        ],
        &[1.0],
    )
    .unwrap()
}
#[test]
fn bend_links_share_exponent_and_ratio_limits_without_allocation() {
    for (exponent, expected) in [
        (-100.0, 2.0_f64.powi(-32)),
        (-1.0, 0.5),
        (0.0, 1.0),
        (1.0, 2.0),
        (100.0, 8.0),
    ] {
        let prepared = PreparedProgram::prepare(
            1,
            1,
            &[op(0, 0, 0, -1), op(55, 1, 0, -1), op(5, -1, 1, 0)],
            &[exponent],
        )
        .unwrap();
        let mut instance = Instance::new(&prepared, 48000.0, 1).unwrap();
        let mut left = [0.0];
        let mut right = [0.0];
        CHANGES.with(|n| n.set(0));
        WATCH.with(|w| w.set(true));
        let result = instance.process([&[0.0], &[0.0]], [&mut left, &mut right], &[]);
        WATCH.with(|w| w.set(false));
        assert_eq!(result, Ok(()));
        assert_eq!(CHANGES.with(Cell::get), 0);
        assert_eq!(left[0], expected as f32);
    }
    assert!(matches!(
        PreparedProgram::prepare(1, 1, &[op(55, 0, 2, -1)], &[]),
        Err(Error::InvalidOperation(0))
    ));
}
#[test]
fn stereo_channel_isolation_and_allocation_guard() {
    let prepared = stereo();
    let mut instance = Instance::new(&prepared, 48000.0, 128).unwrap();
    let left = [0.25; 128];
    let right = [-0.5; 128];
    let mut a = [0.0; 128];
    let mut b = [0.0; 128];
    CHANGES.with(|n| n.set(0));
    WATCH.with(|w| w.set(true));
    let result = instance.process([&left, &right], [&mut a, &mut b], &[]);
    WATCH.with(|w| w.set(false));
    assert_eq!(result, Ok(()));
    assert_eq!(CHANGES.with(Cell::get), 0);
    assert_eq!(a, left);
    assert_eq!(b, right);
    assert_eq!(instance.feedback().generation, 7);
    instance.dispose();
}
#[test]
fn independent_instances_and_timestamped_controls() {
    let prepared = stereo();
    let mut a = Instance::new(&prepared, 48000.0, 128).unwrap();
    let mut b = Instance::new(&prepared, 48000.0, 128).unwrap();
    let input = [1.0; 8];
    let mut left = [0.0; 8];
    let mut right = [0.0; 8];
    let controls = [
        ControlEvent {
            offset: 3,
            value_index: 0,
            value: 0.25,
            generation: 7,
        },
        ControlEvent {
            offset: 3,
            value_index: 0,
            value: 0.5,
            generation: 7,
        },
    ];
    a.process([&input, &input], [&mut left, &mut right], &controls)
        .unwrap();
    assert_eq!(left, [1.0, 1.0, 1.0, 0.5, 0.5, 0.5, 0.5, 0.5]);
    b.process([&input, &input], [&mut left, &mut right], &[])
        .unwrap();
    assert_eq!(left, input);
    a.reset();
    assert_eq!(a.feedback().rendered_frames, 0);
}
#[test]
fn malformed_profiles_stale_generation_and_overflow_rejected() {
    assert!(matches!(
        PreparedProgram::prepare(1, 1, &[op(46, 0, -1, -1)], &[]),
        Err(Error::InvalidOperation(0))
    ));
    assert!(PreparedProgram::prepare(1, 1, &[op(0, 0, 5, -1)], &[0.0]).is_err());
    assert!(PreparedProgram::prepare(2, 1, &[], &[]).is_err());
    assert!(PreparedProgram::prepare(1, 1, &[op(1, 0, 0, 1)], &[]).is_err());
    let mut instance = Instance::new(&stereo(), 44100.0, 128).unwrap();
    let input = [1.0; 8];
    let mut a = [9.0; 8];
    let mut b = [9.0; 8];
    let event = ControlEvent {
        offset: 0,
        value_index: 0,
        value: 0.0,
        generation: 6,
    };
    assert_eq!(
        instance.process([&input, &input], [&mut a, &mut b], &[event]),
        Err(Error::StaleGeneration)
    );
    assert_eq!(a, [9.0; 8]);
    assert_eq!(
        instance.process([&input, &input], [&mut a, &mut b], &[event; 257]),
        Err(Error::EventOverflow)
    );
    assert_eq!(instance.feedback().event_overflows, 1);
}
#[test]
fn oscillator_reset_and_legacy_mono_input() {
    let mut sine = op(3, 1, 0, 0);
    sine.state = 0;
    let prepared =
        PreparedProgram::prepare(1, 1, &[op(0, 0, 0, -1), sine, op(5, -1, 1, 0)], &[440.0])
            .unwrap();
    let mut instance = Instance::new(&prepared, 48000.0, 128).unwrap();
    let input = [0.0; 128];
    let mut a = [0.0; 128];
    let mut b = [0.0; 128];
    instance
        .process([&input, &input], [&mut a, &mut b], &[])
        .unwrap();
    let first = a;
    instance.reset();
    instance
        .process([&input, &input], [&mut a, &mut b], &[])
        .unwrap();
    assert_eq!(first, a);
    assert!(a.iter().any(|v| *v != 0.0));
    let prepared = PreparedProgram::prepare(
        1,
        1,
        &[op(0, 0, 0, -1), op(11, 1, 0, -1), op(5, -1, 1, 0)],
        &[1.0],
    )
    .unwrap();
    let mut mono = Instance::new(&prepared, 48000.0, 128).unwrap();
    mono.process([&[1.0; 128], &[-1.0; 128]], [&mut a, &mut b], &[])
        .unwrap();
    assert_eq!(a, [0.0; 128]);
}

#[test]
fn ordered_simultaneous_notes_pitch_bend_and_exact_offsets_without_allocation() {
    let prepared = PreparedProgram::prepare(
        1,
        9,
        &[
            op(0, 0, 0, -1),
            op(0, 1, 1, -1),
            op(27, 2, 1, 0),
            op(2, 3, 2, 1),
            op(5, -1, 3, 0),
        ],
        &[0.0, 0.001],
    )
    .unwrap();
    let mut instance = Instance::new(&prepared, 48000.0, 128).unwrap();
    let events = [
        Event {
            offset: 1,
            kind: EventKind::NoteOn {
                channel: 1,
                note: 60,
                velocity: 0.5,
            },
        },
        Event {
            offset: 1,
            kind: EventKind::NoteOn {
                channel: 2,
                note: 64,
                velocity: 1.0,
            },
        },
        Event {
            offset: 3,
            kind: EventKind::PitchBend {
                channel: 2,
                value: 16383,
                range_semitones: 12.0,
            },
        },
        Event {
            offset: 5,
            kind: EventKind::NoteOff {
                channel: 2,
                note: 64,
            },
        },
        Event {
            offset: 7,
            kind: EventKind::NoteOff {
                channel: 1,
                note: 60,
            },
        },
    ];
    let input = [0.0; 8];
    let mut a = [0.0; 8];
    let mut b = [0.0; 8];
    CHANGES.with(|n| n.set(0));
    WATCH.with(|w| w.set(true));
    let result = instance.process_host([&input, &input], [&mut a, &mut b], &events, &[], &mut []);
    WATCH.with(|w| w.set(false));
    assert_eq!(result, Ok(0));
    assert_eq!(CHANGES.with(Cell::get), 0);
    assert_eq!(a[0], 0.0);
    assert!((a[1] - 0.32962757).abs() < 1e-6);
    assert_eq!(a[1], a[2]);
    assert!((a[3] - 2.0 * a[1]).abs() < 1e-6);
    assert!((a[5] - 0.26162556).abs() < 1e-6);
    assert_eq!(a[7], 0.0);
    let invalid = [Event {
        offset: 0,
        kind: EventKind::UnsupportedMidi { status: 0xa0 },
    }];
    assert_eq!(
        instance.process_host([&input, &input], [&mut a, &mut b], &invalid, &[], &mut []),
        Err(Error::UnsupportedEvent)
    );
}
#[test]
fn control_change_and_midi_output_offsets_and_overflow() {
    let mut send = op(54, -1, 2, 0);
    send.c = 1;
    send.d = 3;
    send.e = 0;
    send.state = 0;
    let prepared = PreparedProgram::prepare(
        1,
        1,
        &[
            op(0, 0, 0, -1),
            op(0, 1, 1, -1),
            op(0, 3, 2, -1),
            op(28, 2, 1, 0),
            send,
            op(5, -1, 2, 0),
        ],
        &[0.0, 7.0, 1.0],
    )
    .unwrap();
    let mut instance = Instance::new(&prepared, 48000.0, 128).unwrap();
    let input = [0.0; 8];
    let mut a = [0.0; 8];
    let mut b = [0.0; 8];
    let mut midi = [MidiOutput::default(); 4];
    let events = [Event {
        offset: 3,
        kind: EventKind::ControlChange {
            channel: 1,
            controller: 7,
            value: 0.25,
        },
    }];
    assert_eq!(
        instance.process_host([&input, &input], [&mut a, &mut b], &events, &[], &mut midi),
        Ok(1)
    );
    assert_eq!(a, [0.0, 0.0, 0.0, 0.25, 0.25, 0.25, 0.25, 0.25]);
    assert_eq!(midi[0].offset, 3);
    assert_eq!(midi[0].kind, MidiOutputKind::ControlChange);
    assert_eq!(midi[0].number, 7);
    assert!((midi[0].value - 32.0 / 127.0).abs() < 1e-9);
    let events = [Event {
        offset: 1,
        kind: EventKind::ControlChange {
            channel: 1,
            controller: 7,
            value: 0.5,
        },
    }];
    instance
        .process_host([&input, &input], [&mut a, &mut b], &events, &[], &mut [])
        .unwrap();
    assert_eq!(instance.feedback().midi_output_overflows, 1);
    let mut note_send = op(53, -1, 0, 1);
    note_send.c = 2;
    note_send.d = 2;
    note_send.state = 0;
    note_send.value = 1.0;
    let prepared = PreparedProgram::prepare(
        1,
        2,
        &[op(0, 0, 0, -1), op(0, 1, 1, -1), op(0, 2, 2, -1), note_send],
        &[0.0, 60.0, 1.0],
    )
    .unwrap();
    let mut instance = Instance::new(&prepared, 48000.0, 128).unwrap();
    let event = Event {
        offset: 4,
        kind: EventKind::Control {
            value_index: 0,
            value: 1.0,
            generation: 2,
        },
    };
    assert_eq!(
        instance.process_host([&input, &input], [&mut a, &mut b], &[event], &[], &mut midi),
        Ok(1)
    );
    assert_eq!(midi[0].offset, 4);
    assert_eq!(midi[0].kind, MidiOutputKind::NoteOn);
}
#[test]
fn authoritative_tempo_phase_stop_start_seek_loop_and_within_block_changes() {
    let mut frequency = op(32, 2, 0, 1);
    frequency.c = 15;
    frequency.d = 1;
    frequency.e = 1;
    let mut click = frequency;
    click.out = 3;
    click.c = 5;
    let prepared = PreparedProgram::prepare(
        1,
        1,
        &[
            op(0, 0, 0, -1),
            op(0, 1, 1, -1),
            frequency,
            click,
            op(5, -1, 2, 0),
            op(5, -1, 3, 1),
        ],
        &[90.0, 0.0],
    )
    .unwrap();
    let mut instance = Instance::new(&prepared, 48000.0, 128).unwrap();
    let beat = 0.99999;
    let segments = [
        TimelineSegment {
            offset: 0,
            render_frame: 0,
            beat,
            bpm: 120.0,
            running: true,
            discontinuity: Discontinuity::Start,
        },
        TimelineSegment {
            offset: 3,
            render_frame: 3,
            beat: beat + 3.0 / 24000.0,
            bpm: 300.0,
            running: true,
            discontinuity: Discontinuity::None,
        },
        TimelineSegment {
            offset: 5,
            render_frame: 5,
            beat: beat + 3.0 / 24000.0 + 2.0 / 9600.0,
            bpm: 300.0,
            running: false,
            discontinuity: Discontinuity::Stop,
        },
        TimelineSegment {
            offset: 7,
            render_frame: 7,
            beat: 2.0,
            bpm: 60.0,
            running: true,
            discontinuity: Discontinuity::Start,
        },
        TimelineSegment {
            offset: 8,
            render_frame: 8,
            beat: 0.0,
            bpm: 60.0,
            running: true,
            discontinuity: Discontinuity::Loop,
        },
    ];
    let input = [0.0; 10];
    let mut a = [0.0; 10];
    let mut b = [0.0; 10];
    CHANGES.with(|n| n.set(0));
    WATCH.with(|w| w.set(true));
    let result = instance.process_host([&input, &input], [&mut a, &mut b], &[], &segments, &mut []);
    WATCH.with(|w| w.set(false));
    assert_eq!(result, Ok(0));
    assert_eq!(CHANGES.with(Cell::get), 0);
    assert_eq!(a, [2.0, 2.0, 2.0, 5.0, 5.0, 0.0, 0.0, 1.0, 1.0, 1.0]);
    assert_eq!(b[0], 0.0);
    assert_eq!(b[1], 1.0);
    assert_eq!(b[7], 1.0);
    assert_eq!(b[8], 1.0);
    assert_eq!(instance.feedback().render_frame, 9);
    assert_eq!(instance.feedback().bpm, 60.0);
    let seek = [TimelineSegment {
        offset: 0,
        render_frame: 10,
        beat: 10.5,
        bpm: 120.0,
        running: true,
        discontinuity: Discontinuity::Seek,
    }];
    instance
        .process_host([&input, &input], [&mut a, &mut b], &[], &seek, &mut [])
        .unwrap();
    assert_eq!(b[0], 0.0);
    assert_eq!(
        instance.process([&input, &input], [&mut a, &mut b], &[]),
        Err(Error::InvalidTimeline)
    );
}

#[test]
fn bounded_held_note_pool_can_fill_and_retrigger_without_growth() {
    let mut instance = Instance::new(&stereo(), 48000.0, 128).unwrap();
    let input = [0.0; 8];
    let mut a = [0.0; 8];
    let mut b = [0.0; 8];
    let empty = Event {
        offset: 0,
        kind: EventKind::NoteOff {
            channel: 1,
            note: 0,
        },
    };
    for block in 0..8 {
        let mut events = [empty; 256];
        for (index, event) in events.iter_mut().enumerate() {
            let key = block * 256 + index;
            *event = Event {
                offset: 0,
                kind: EventKind::NoteOn {
                    channel: (key / 128 + 1) as u8,
                    note: (key % 128) as u8,
                    velocity: 1.0,
                },
            };
        }
        CHANGES.with(|n| n.set(0));
        WATCH.with(|w| w.set(true));
        let result =
            instance.process_host([&input, &input], [&mut a, &mut b], &events, &[], &mut []);
        WATCH.with(|w| w.set(false));
        assert_eq!(result, Ok(0));
        assert_eq!(CHANGES.with(Cell::get), 0);
    }
    assert_eq!(instance.feedback().held_notes, 2048);
    let retrigger = Event {
        offset: 0,
        kind: EventKind::NoteOn {
            channel: 1,
            note: 0,
            velocity: 0.5,
        },
    };
    CHANGES.with(|n| n.set(0));
    WATCH.with(|w| w.set(true));
    let result = instance.process_host(
        [&input, &input],
        [&mut a, &mut b],
        &[retrigger],
        &[],
        &mut [],
    );
    WATCH.with(|w| w.set(false));
    assert_eq!(result, Ok(0));
    assert_eq!(CHANGES.with(Cell::get), 0);
    assert_eq!(instance.feedback().held_notes, 2048);
    instance.reset();
    assert_eq!(instance.feedback().held_notes, 0);
}

#[test]
fn legacy_kernel_input_is_mono_until_api_two_opt_in() {
    teia_kernel::clearDspProgram();
    teia_kernel::setDspStereoInputEnabled(0);
    teia_kernel::setDspValueImmediate(0, 1.0);
    for instruction in [op(0, 0, 0, -1), op(11, 1, 0, 0), op(5, -1, 1, 0)] {
        assert!(
            teia_kernel::addDspOp(
                instruction.opcode,
                instruction.out,
                instruction.a,
                instruction.b,
                instruction.c,
                instruction.d,
                instruction.e,
                instruction.state,
                instruction.value,
                instruction.value2,
                instruction.value3,
                instruction.value4
            ) >= 0
        );
    }
    unsafe {
        *teia_kernel::inputPtr() = 0.25;
        *teia_kernel::inputLeftPtr() = 1.0;
        *teia_kernel::inputRightPtr() = -1.0;
    }
    teia_kernel::clear(1);
    teia_kernel::renderDspProgram(1, 48000.0);
    assert_eq!(unsafe { *teia_kernel::leftPtr() }, 0.25);
    teia_kernel::setDspStereoInputEnabled(1);
    teia_kernel::clear(1);
    teia_kernel::renderDspProgram(1, 48000.0);
    assert_eq!(unsafe { *teia_kernel::leftPtr() }, 1.0);
    teia_kernel::setDspStereoInputEnabled(0);
}

#[test]
fn bounded_spread_grow_shrink_and_spawn_recycle_do_not_allocate() {
    let mut spread = op(42, -1, 0, 4);
    spread.state = 0;
    spread.value = 0.0;
    spread.value2 = 1.0;
    let mut time = op(37, 1, -1, -1);
    time.state = 0;
    let prepared = PreparedProgram::prepare(
        1,
        1,
        &[
            op(0, 0, 0, -1),
            spread,
            time,
            op(5, -1, 1, 0),
            op(45, -1, -1, -1),
        ],
        &[2.0],
    )
    .unwrap();
    let resources = Resources {
        repeat_capacity: Some(3),
        repeat_memory_budget: 1024 * 1024,
        ..Resources::default()
    };
    let mut instance = Instance::new_with_resources(&prepared, 48000.0, 8, &resources).unwrap();
    let zero = [0.0; 8];
    let mut left = [0.0; 8];
    let mut right = [0.0; 8];
    for count in [2.0, 1.0, 3.0, 0.0, 3.0, 10.0] {
        let controls = [ControlEvent {
            offset: 0,
            value_index: 0,
            value: count,
            generation: 1,
        }];
        CHANGES.with(|n| n.set(0));
        WATCH.with(|w| w.set(true));
        let result = instance.process([&zero, &zero], [&mut left, &mut right], &controls);
        WATCH.with(|w| w.set(false));
        assert_eq!(result, Ok(()));
        assert_eq!(CHANGES.with(Cell::get), 0);
    }
    assert!(instance.feedback().repeat_exhaustions > 0);
    let mut begin = op(46, 2, 0, 6);
    begin.c = 1;
    begin.state = 0;
    begin.value2 = 1.0;
    let prepared = PreparedProgram::prepare(
        1,
        1,
        &[
            op(0, 0, 0, -1),
            begin,
            op(0, 1, 1, -1),
            time,
            op(5, -1, 1, 0),
            op(0, 4, 1, -1),
            op(47, -1, -1, -1),
        ],
        &[0.0, 0.0],
    )
    .unwrap();
    let mut instance = Instance::new_with_resources(&prepared, 48000.0, 8, &resources).unwrap();
    for index in 0..8 {
        let controls = [ControlEvent {
            offset: 0,
            value_index: 0,
            value: if index % 2 == 0 { 1.0 } else { 0.0 },
            generation: 1,
        }];
        CHANGES.with(|n| n.set(0));
        WATCH.with(|w| w.set(true));
        let result = instance.process([&zero, &zero], [&mut left, &mut right], &controls);
        WATCH.with(|w| w.set(false));
        assert_eq!(result, Ok(()));
        assert_eq!(CHANGES.with(Cell::get), 0);
    }
    assert!(instance.feedback().repeat_exhaustions > 0);
    for index in 0..20 {
        let controls = [
            ControlEvent {
                offset: 0,
                value_index: 0,
                value: if index % 2 == 0 { 1.0 } else { 0.0 },
                generation: 1,
            },
            ControlEvent {
                offset: 0,
                value_index: 1,
                value: if index % 4 == 2 { 1.0 } else { 0.0 },
                generation: 1,
            },
        ];
        CHANGES.with(|n| n.set(0));
        WATCH.with(|w| w.set(true));
        let result = instance.process([&zero, &zero], [&mut left, &mut right], &controls);
        WATCH.with(|w| w.set(false));
        assert_eq!(result, Ok(()));
        assert_eq!(CHANGES.with(Cell::get), 0);
        if index == 8 {
            instance.reset();
        }
    }
}
