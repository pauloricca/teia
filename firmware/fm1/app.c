/* SPDX-License-Identifier: GPL-3.0-only
 * Teia FM-1 bench shell. Hardware/startup/USB/updater services derive from Felucca,
 * Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments.
 * No Felucca synth engine, mixer, sequencer, factory samples or effects are linked. */
#include <stdint.h>
#define FELUCCA_CDC 0
#define FELUCCA_UAC 0
#define FELUCCA_OTA 1
#define FELUCCA_ID "FM-1_915"
#define RING_PUBLISH() __asm__ volatile("" ::: "memory")
#include "fm1_time.h"
#include "fm1_sys.h"
#include "fm1_irq.h"
#include "fm1_guard.h"
#include "fm1_input.h"
#include "fm1_timer.h"
#include "fm1_audio.h"
#include "fm1_adc.h"
#include "fm1_lcd_hw.h"
#include "fm1_flash.h"
#include "libc.c"
#include "lcd.c"
#include "usb.c"
#include "midi_uart.c"
#include "upload.h"
#include "font.h"

#define HALF_FRAMES 128u
#define HALF_WORDS (HALF_FRAMES * 2u)
#define BOOT_MAGIC 0x54454941u
struct { uint32_t magic, failed, pending; } bootguard __attribute__((section(".noinit")));
static union { uint64_t align; uint8_t bytes[16384]; teia_runtime_t runtime; } arena __attribute__((section(".pool")));
_Static_assert(sizeof(teia_runtime_t) <= 16384, "Teia runtime exceeds arena");
static int32_t abuf[2u * HALF_WORDS] __attribute__((aligned(4)));
static volatile uint32_t in_audio, halves, max_ticks, late, overflow_count;
static teia_upload_t patches __attribute__((section(".pool")));
static volatile int32_t master_target;
static uint32_t switch_faded, switch_gain = TEIA_Q;
static int32_t master_smooth;
static uint8_t held[128], keyboard_ready, flash_ok;
static uint32_t physical_notes;
/* The physical keyboard is transposed independently from incoming MIDI. */
static volatile int32_t keyboard_octave;
static uint16_t text_pixels[240u * 14u];
static void text_line(uint32_t y, const char *text)
{
    uint32_t x, row, n = str_len(text); if (n > 30) n = 30;
    lcd_sync();
    for (row = 0; row < 14; ++row)
        for (x = 0; x < 240; ++x) {
            uint32_t c = x / 8 < n ? (uint8_t)text[x / 8] : 32;
            uint16_t ink = c >= 32 && c <= 126 && (teia_font[c - 32][row] & (1u << (7u - x % 8u))) ? 0xFFFFu : 0;
            text_pixels[row * 240u + x] = ink;
        }
    lcd_blit(0, y, 240, 14, text_pixels); lcd_sync();
}
static void number_line(uint32_t y, const char *label, uint32_t n)
{
    char line[31], digits[12]; uint32_t len, k = 0;
    str_cpy(line, label, sizeof line); len = str_len(line);
    do { digits[k++] = (char)('0' + n % 10u); n /= 10u; } while (n && k < 10);
    while (k && len < 30) line[len++] = digits[--k];
    line[len] = 0; text_line(y, line);
}
/* Params values are Q16.16. Show the declared-unit value rather than a
 * normalized encoder position. Four decimal places retain useful precision
 * while still fitting alongside the longest permitted Params label. */
static void parameter_line(uint32_t y, const char *label, int32_t value)
{
    char line[31], digits[12];
    uint64_t magnitude = value < 0 ? (uint64_t)-(int64_t)value : (uint64_t)value;
    uint32_t whole = (uint32_t)(magnitude / TEIA_Q);
    uint32_t fraction = (uint32_t)(((magnitude % TEIA_Q) * 10000u + TEIA_Q / 2u) / TEIA_Q);
    uint32_t len, k = 0, fractional_digits = 4;
    if (fraction == 10000u) { ++whole; fraction = 0; }
    str_cpy(line, label, sizeof line); len = str_len(line);
    if (value < 0 && (whole || fraction) && len < 30) line[len++] = '-';
    do { digits[k++] = (char)('0' + whole % 10u); whole /= 10u; } while (whole && k < sizeof digits);
    while (k && len < 30) line[len++] = digits[--k];
    while (fractional_digits && fraction % 10u == 0) { fraction /= 10u; --fractional_digits; }
    if (fractional_digits && len < 30) {
        line[len++] = '.';
        k = 0;
        do { digits[k++] = (char)('0' + fraction % 10u); fraction /= 10u; } while (k < fractional_digits);
        while (k && len < 30) line[len++] = digits[--k];
    }
    line[len] = 0; text_line(y, line);
}
/* Params are ordered to match the six physical controls.  Keep the control
 * reference on screen so a patch's labels can be read without consulting the
 * panel layout. */
static void parameter_label(char *line, const char *control, const char *label)
{
    uint32_t len = 0, k;
    for (k = 0; control[k] && len < 30; ++k) line[len++] = control[k];
    if (len < 30) line[len++] = ' ';
    for (k = 0; label[k] && len < 30; ++k) line[len++] = label[k];
    if (len < 30) line[len++] = ' ';
    line[len] = 0;
}
static void clear_notes(void) { uint32_t i; for (i = 0; i < 128; ++i) held[i] = 0; }
static void octave_leds(void)
{
    /* Match the stock UI: a steady light points back towards octave zero. */
    fm1_led_key(FM1_BTN_OCT_DOWN, keyboard_octave < 0);
    fm1_led_key(FM1_BTN_OCT_UP, keyboard_octave > 0);
}
static void octave_buttons(void)
{
    uint32_t down = 1u << FM1_BTN_OCT_DOWN, up = 1u << FM1_BTN_OCT_UP;
    uint32_t pressed = fm1_input_edges(0);
    if (!(pressed & (down | up))) return;
    if ((fm1_in.buttons & (down | up)) == (down | up))
        keyboard_octave = 0;
    else if (pressed & down)
        keyboard_octave = keyboard_octave > -3 ? keyboard_octave - 1 : -3;
    else
        keyboard_octave = keyboard_octave < 3 ? keyboard_octave + 1 : 3;
    octave_leds();
}
static void inputs_audio(void)
{
    static uint32_t reset_seen;
    uint32_t i, notes = fm1_in.notes, triggered = 0; int note = -1;
    if (reset_seen != usb.resets) {
        reset_seen = usb.resets;
        for (i = 0; i < 128; ++i) held[i] &= (uint8_t)~1u;
    }
    if (midi_in_overflow) {
        clear_notes(); mi_r = mi_w; midi_in_overflow = 0; ++overflow_count;
    }
    while (mi_r != mi_w) {
        uint32_t at = mi_r % MQ, packet = midi_in_q[at], status = (packet >> 8) & 255u;
        uint8_t source = midi_in_source[at] == 2u ? 2u : 1u;
        uint32_t a = (packet >> 16) & 127u, b = (packet >> 24) & 127u;
        RING_PUBLISH(); ++mi_r;
        /* One mono voice, channel 1. Other channels and clock have no musical side effects. */
        if (status == 0x90u && b) { held[a] |= source; triggered = 1; }
        if (status == 0x80u || (status == 0x90u && !b)) held[a] &= (uint8_t)~source;
        if (status == 0xB0u && (a == 120u || a == 123u))
            for (i = 0; i < 128; ++i) held[i] &= (uint8_t)~source;
    }
    if (!notes) keyboard_ready = 1; /* Keys held while booting never make a surprise note. */
    if (keyboard_ready) {
        if (notes & ~physical_notes) triggered = 1;
        for (i = 0; i < 27; ++i) if (notes & (1u << i))
            note = teia_clamp((int32_t)i + 53 + 12 * keyboard_octave, 0, 127);
    }
    physical_notes = notes;
    for (i = 0; i < 128; ++i) if (held[i] && (int)i > note) note = (int)i;
    {
        teia_patch_t *p = patches.slots[patches.active];
        if (!p->valid) return;
        arena.runtime.midi_gate = note >= 0 ? TEIA_Q : 0;
        arena.runtime.midi_note = note >= 0 ? note * TEIA_Q : 0;
        arena.runtime.midi_frequency = note >= 0 ? note_frequency[note] : 0;
        arena.runtime.midi_velocity = note >= 0 ? TEIA_Q : 0;
        /* A MIDI Note trigger is consumed by the first frame of this audio
         * half. Keep it separate from midi_gate, which stays high while the
         * selected note is held. */
        arena.runtime.midi_trigger_pending = triggered;
        if (p->version < 4) {
            arena.runtime.values[p->params[2]] = arena.runtime.midi_gate;
            if (note >= 0) arena.runtime.values[p->params[1]] = arena.runtime.midi_frequency;
        }
        for (i = 0; i < p->knob_count; ++i) {
            uint32_t index = p->knobs[i].value;
            arena.runtime.values[index] = p->program.values[index];
        }
    }
}
static int32_t approach(int32_t value, int32_t target)
{
    int32_t delta = target - value;
    return value + (delta > 0 ? (delta + 511) / 512 : delta < 0 ? (delta - 511) / 512 : 0);
}
void fm1_alnk0_irq(void)
{
    uint32_t pending = fm1_audio_pending(), start = fm1_ticks();
    in_audio = 1; fm1_audio_ack_aux((uint8_t)pending);
    if (pending & FM1_AUDIO_HALF) {
        uint32_t half = fm1_audio_free_half(), i;
        int32_t *out = abuf + half * HALF_WORDS;
        uint32_t fading;
        teia_patch_t *p;
        if (patches.pending && switch_faded) { teia_apply(&patches, &arena.runtime); switch_faded = 0; switch_gain = 0; }
        fading = patches.pending != 0;
        p = patches.slots[patches.active];
        inputs_audio();
        teia_prepare_block(&arena.runtime);
        for (i = 0; i < HALF_FRAMES; ++i) {
            int32_t l, r;
            if (p->valid && p->version < 4) {
                uint32_t level = p->params[0];
                arena.runtime.values[level] = approach(arena.runtime.values[level], p->program.values[level]);
            }
            if (fading) switch_gain = switch_gain > 512u ? switch_gain - 512u : 0;
            else if (switch_gain < TEIA_Q) switch_gain += 512u;
            master_smooth = approach(master_smooth, master_target);
            /* Legacy packages smooth their level every sample. Current
             * packages snapshot all Params once per half-buffer. */
            if(p->valid && p->version<4) teia_sample(&arena.runtime,&l,&r);
            else teia_sample_prepared(&arena.runtime,&l,&r);
            /* Q16.16 -> bounded 24-bit output, with 6 dB additional bench headroom. */
            out[2u * i] = teia_mul(teia_mul(l, (int32_t)switch_gain), master_smooth) * 64;
            out[2u * i + 1u] = teia_mul(teia_mul(r, (int32_t)switch_gain), master_smooth) * 64;
        }
        if (fading) switch_faded = 1;
        fm1_audio_ack_half(); ++halves;
        if (fm1_audio_free_half() != half) ++late;
        start = fm1_ticks() - start;
        if (start > max_ticks) max_ticks = start;
    }
    in_audio = 0;
}
void fm1_timer5_irq(void)
{
    static uint32_t sub, last, acc;
    uint32_t now = fm1_ticks();
    fm1_timer5_ack(); fm1_input_tick();
    acc += now - last; last = now;
    while (acc >= 24000u) { acc -= 24000u; ++fm1_ms; }
    if (++sub >= 5 && !in_audio) { sub = 0; usb_poll(); uart_midi_poll(); }
}
extern void isr_alnk0(void), isr_timer5(void);
static void silence(void) { uint32_t i; fm1_audio_stop(); for (i = 0; i < 2 * HALF_WORDS; ++i) abuf[i] = 0; }
static void recover(void)
{
    silence(); bootguard.pending = 0; usb_detach(); fm1_delay_ms(30); fm1_enter_uboot();
}
static void fm1_fault(const fm1_crash_t *crash)
{
    (void)crash; silence(); fm1_reboot(); /* Boot-loop guard enters UBOOT after repeated failures. */
}

/* Keep the existing updater protocol and loader, with a minimal progress screen. */
static uint32_t ota_now_ms(void) { return fm1_ms; }
static void ota_idle(void) { fm1_wdt_feed(); }
static int ota_erase(uint32_t off)
{
    uint32_t took;
    if (!flash_ok || !FL_IN(off, 4096u, FL_OTA_LO, FL_OTA_HI) || (off & 4095u)) return -8;
    return fl_erase4k(off, &took);
}
static int ota_prog(uint32_t off, const void *p, uint32_t n)
{
    if (!flash_ok || !FL_IN(off, n, FL_OTA_LO, FL_OTA_HI)) return -8;
    return fl_write(off, p, n);
}
static int ota_fread(uint32_t off, void *p, uint32_t n)
{
    uint32_t lock; int rc;
    if (!flash_ok || !FL_IN(off, n, FL_OTA_LO, FL_OTA_HI)) return -8;
    lock = fm1__lock(); rc = FL_FAR(fl_read_ram)(off, p, n); fm1__unlock(lock); return rc;
}
static void ota_show(uint32_t step, int32_t code)
{
    number_line(168, "UPDATE STEP ", step);
    if (code < 0) number_line(184, "UPDATE ERROR ", (uint32_t)-code);
}
static void ota_commit(const uint8_t *parm)
{
    bootguard.pending = 0; usb_detach(); fm1_delay_ms(30); fm1_enter_update(parm);
}
#include "ota.c"

/* Patch commands share the bounded USB SysEx mailbox, leaving updater frames alone. */
static int patch_service(void)
{
    static uint32_t reset_seen, last_rx;
    static uint8_t waiting, command, token, status;
    const uint8_t *frame; uint32_t n, decoded;
    uint8_t body[98], reply[14];
    if (reset_seen != usb.resets) {
        reset_seen = usb.resets; patches.receiving = 0; waiting = 0;
    }
    if (patches.receiving && fm1_ms - last_rx > 10000u) patches.receiving = 0;
    if (waiting) {
        if (patches.pending) return 1;
    } else {
        if (!ota_frame_get(&frame, &n)) return 0;
        if (n < 4 || frame[0] != 0x7d || frame[1] != 0x54 || frame[2] != 0x45 || frame[3] != 1) return 0;
        if (n < 6) { ota_frame_done(); return 1; }
        command = frame[4]; token = frame[5]; last_rx = fm1_ms;
        decoded = ota_unpack7(frame+6, n-6, body, sizeof body);
        status = decoded > sizeof body || (decoded * 8u + 6u) / 7u != n-6 ? 1 : teia_request(&patches, command, body, decoded);
        if (!status && (command == 3 || command == 4)) { waiting = 1; return 1; }
    }
    reply[0]=0xf0; reply[1]=0x7d; reply[2]=0x54; reply[3]=0x45; reply[4]=1;
    reply[5]=command | 0x40; reply[6]=token; reply[7]=status;
    reply[8]=(uint8_t)(patches.received & 127u); reply[9]=(uint8_t)(patches.received >> 7);
    reply[10]=(uint8_t)patches.active;
    reply[11]=(uint8_t)(patches.slots[0]->valid | (patches.slots[1]->valid << 1)); reply[12]=0xf7;
    if (command == 5) { reply[12] = TEIA_PACKAGE_VERSION; reply[13] = 0xf7; }
    (void)ota_wire_send(reply, command == 5 ? 14u : 13u); waiting = 0; ota_frame_done(); return 1;
}

static void main_loop(void)
{
    uint32_t last_ui = 0, last_control = 0, recovery_since = 0;
    lcd_init(); text_line(8, "TEIA / FM-1 DSP SPIKE");
    text_line(30, "EMPTY / UPLOAD A PATCH");
    text_line(50, "KEYS OR MIDI CHANNEL 1");
    text_line(64, "KNOBS: PARAMETER VALUES");
    text_line(202, "HOLD OCT- AND OCT+: RECOVERY");
    fm1_input_init(); octave_leds(); fm1_adc_init();
    (void)fm1_adc_read(FM1_ADC_MASTER);
    { int32_t pot = fm1_adc_read(FM1_ADC_MASTER); if (pot >= 0) master_target = pot * pot / 16; }
    master_smooth = master_target;
    teia_upload_init(&patches);
    /* Read the JEDEC id before interrupts; unknown parts never get flash writes. */
    flash_ok = FL_FAR(fl_jedec_ram)() == 0x856014u;
    usb_start(); uart_midi_init(); fm1_timer5_start(isr_timer5, 4);
    fm1_irq_enable_all();
    if (flash_ok) ota_boot_cleanup();
    fm1_irq_off(); fm1_audio_init(abuf, HALF_WORDS, isr_alnk0, 3);
    fm1_guard_lock_top(); fm1_irq_enable_all();
    for (;;) {
        uint32_t now = fm1_ms;
        fm1_wdt_feed(); usb_retry(now);
        if (now >= 30000u) { bootguard.pending = 0; bootguard.failed = 0; }
        if (usb.uboot_req) recover();
        if ((fm1_in.buttons & 3u) == 3u) {
            if (!recovery_since) recovery_since = now;
            if (now - recovery_since > 5000u) recover();
        } else recovery_since = 0;
        if (usb.ota_req) {
            usb.ota_req = 0; silence();
            if (flash_ok) ota_session();
            clear_notes(); keyboard_ready = 0;
            patches.receiving = patches.pending = 0; switch_faded = 0; switch_gain = 0;
            if (patches.slots[patches.active]->valid) teia_load(&arena.runtime, &patches.slots[patches.active]->program);
            fm1_irq_off(); fm1_guard_unlock_top(); fm1_audio_init(abuf, HALF_WORDS, isr_alnk0, 3);
            fm1_guard_lock_top(); fm1_irq_enable_all();
        }
        if (!patch_service()) ota_service();
        if (now - last_control >= 5u) {
            int32_t pot, delta;
            last_control = now;
            octave_buttons();
            delta = fm1_enc_take(6); /* PRESETS */
            if (delta && !patches.pending) {
                patches.destination = (uint32_t)teia_clamp((int32_t)patches.active + (delta > 0 ? 1 : -1), 0, 1);
                if (patches.destination != patches.active) { RING_PUBLISH(); patches.pending = 2; }
            }
            { uint32_t k;
                static const uint8_t control_encoders[6] = {2, 3, 4, 5, 0, 1};
                for (k = 0; k < 6; ++k) {
                    delta = fm1_enc_take(control_encoders[k]);
                    if (delta && !patches.pending) {
                        teia_patch_t *p = patches.slots[patches.active];
                        if (!p->valid || k >= p->knob_count) continue;
                        teia_knob_t *knob = &p->knobs[k];
                        int64_t v = (int64_t)p->program.values[knob->value] + (int64_t)delta * knob->step;
                        p->program.values[knob->value] = v < knob->min ? knob->min : v > knob->max ? knob->max : (int32_t)v;
                    }
                }
            }
            pot = fm1_adc_read(FM1_ADC_MASTER);
            if (pot >= 0) master_target = pot * pot / 16;
        }
        if (now - last_ui >= 200u) {
            last_ui = now;
            {
                uint32_t k; teia_patch_t *p = patches.slots[patches.active];
                char header[31], digits[2];
                static const char *control_names[6] = {"K1", "K2", "K3", "K4", "SEL", "ALG"};
                digits[0] = (char)('1' + patches.active); digits[1] = 0;
                str_cpy(header, digits, sizeof header);
                { uint32_t len = str_len(header); header[len++] = ' '; header[len] = 0; }
                { const char *name = p->valid ? p->name : "EMPTY / UPLOAD A PATCH";
                    uint32_t len = str_len(header), n = 0;
                    while (name[n] && len < 30) header[len++] = name[n++];
                    header[len] = 0;
                }
                text_line(30, header);
                text_line(44, "");
                for (k = 0; k < 6; ++k) {
                    char label[31];
                    if (p->valid && k < p->knob_count) {
                        parameter_label(label, control_names[k], p->knobs[k].label);
                        parameter_line(58 + 14*k, label, p->program.values[p->knobs[k].value]);
                    } else text_line(58 + 14*k, "");
                }
            }
            number_line(150, "MAX RENDER US ", max_ticks / 24u);
            number_line(166, "LATE BUFFERS ", late);
            number_line(182, "MIDI OVERFLOWS ", overflow_count);
        }
    }
}
extern uint32_t _data_start[], _data_end[], _data_load[], _bss_start[], _bss_end[];
extern uint32_t _pool_start[], _pool_end[], _rt_start[], _rt_end[], _rt_load[];
void fm1_cstart(void)
{
    uint32_t *s, *d;
    fm1_time_init(); fm1_wdt_arm(0x0D);
    if (bootguard.magic != BOOT_MAGIC) { bootguard.magic = BOOT_MAGIC; bootguard.failed = bootguard.pending = 0; }
    if (bootguard.pending) ++bootguard.failed;
    bootguard.pending = 1;
    if (bootguard.failed >= 2) { bootguard.failed = bootguard.pending = 0; fm1_enter_uboot(); }
    fm1_irq_init();
    for (d = _bss_start; d < _bss_end; ++d) *d = 0;
    for (d = _pool_start; d < _pool_end; ++d) *d = 0;
    for (s = _data_load, d = _data_start; d < _data_end; ++s, ++d) *d = *s;
    for (s = _rt_load, d = _rt_start; d < _rt_end; ++s, ++d) *d = *s;
    fm1_mailbox_clear();
    fm1_guard_enable(FM1_GUARD_STACK | FM1_GUARD_WRITE | FM1_GUARD_BUS | FM1_GUARD_PC);
    main_loop();
}
