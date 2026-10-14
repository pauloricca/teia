/* SPDX-License-Identifier: GPL-3.0-only */
/* Bounded, allocation-free spike backend: Q16.16 values and Q0.32 oscillator phase.
 * Supports only the subset checked by export-patch.mjs, not general Teia programs. */
#ifndef TEIA_FM1_RUNTIME_H
#define TEIA_FM1_RUNTIME_H
#include <stdint.h>
#include "teia_limits.h"
#define TEIA_FS 44100u
#define TEIA_Q 65536
/* Match sanitize_dsp_register in the WASM interpreter at graph arithmetic
 * boundaries. Internal DSP helpers retain the full Q16.16 working range. */
#define TEIA_DSP_LIMIT (12000 * TEIA_Q)
_Static_assert(TEIA_FS == TEIA_DELAY_SAMPLE_RATE, "Delay contract sample rate differs");
_Static_assert(TEIA_MAX_DELAY_SAMPLES == TEIA_FS + 1u, "Delay requires one second plus interpolation guard");
typedef struct {
    uint32_t position, filled, time;
    uint8_t ready;
} teia_delay_state_t;
typedef struct { int16_t code, out, a, b, c, state, d, e, f, g, h, i; } teia_op_t;
typedef struct {
    uint32_t count, registers, value_count;
    teia_op_t ops[TEIA_MAX_OPS];
    int32_t values[TEIA_MAX_VALUES];
} teia_program_t;
typedef struct {
    int32_t level, start;
    uint32_t elapsed, duration, phase;
    uint8_t gate, stage, trigger, coeff_valid, ended;
    int32_t coeff[5], cutoff, q, x1, x2, y1, y2;
    uint32_t progress_duration, progress_elapsed, progress_value, progress_remainder;
    uint32_t progress_step, progress_step_remainder;
} teia_state_t;
typedef struct { uint8_t note, velocity, channel, on; } teia_note_event_t;
typedef struct {
    int32_t tags[TEIA_MAX_INSTANCES];
    uint8_t active[TEIA_MAX_INSTANCES], gates[TEIA_MAX_INSTANCES], kills[TEIA_MAX_INSTANCES];
    uint8_t trigger, release, count;
} teia_repeat_t;
typedef struct {
    const teia_program_t *program;
    int32_t values[TEIA_MAX_VALUES], regs[TEIA_MAX_REGS];
    teia_state_t state[TEIA_MAX_STATES];
    /* Feedback has one-sample history independent of node-local DSP state. */
    int32_t feedback[TEIA_MAX_STATES];
    /* Pool-backed, independent 16-bit lines. A valid-history count avoids a
     * large buffer clear in the audio interrupt when switching patches. */
    int16_t delay[TEIA_MAX_DELAYS][TEIA_MAX_DELAY_SAMPLES];
    teia_delay_state_t delay_state[TEIA_MAX_DELAYS];
    int8_t delay_slot[TEIA_MAX_STATES];
    /* The board turns physical keys and channel-1 MIDI into this mono source. */
    int32_t midi_note, midi_frequency, midi_velocity, midi_gate, midi_trigger;
    /* A pending note-on is consumed by exactly one rendered sample. */
    uint8_t midi_trigger_pending;
    uint32_t rejected;
    teia_note_event_t events[TEIA_EVENT_QUEUE], event;
    uint16_t event_read, event_write, event_count;
    uint8_t event_active, event_gap, event_overflow;
    teia_repeat_t repeats[TEIA_MAX_CONTAINERS];
    uint16_t repeat_offset, repeat_item;
    uint8_t repeat_gate, block_start;
    /* Stable, dependency-ordered execution lists. Controls are prepared once
     * per audio half; everything stateful and MIDI-dependent stays per sample. */
    uint16_t control_ops[TEIA_MAX_OPS], audio_ops[TEIA_MAX_OPS];
    uint16_t control_count, audio_count;
    int32_t prepared_values[TEIA_MAX_VALUES];
    uint8_t controls_valid;
} teia_runtime_t;
#include "patch.h"

static int teia_reg(int r, uint32_t count) { return r >= 0 && (uint32_t)r < count; }
static int teia_function_arity(int id)
{
    if(id==1 || (id>=13 && id<=17) || id==27) return 1;
    if(id==6 || id==7 || (id>=19 && id<=26)) return 2;
    return id==8 ? 3 : 0;
}
static int teia_validate(const teia_program_t *p)
{
    int repeat_end=-1, repeat_start=0, repeat_states=0, repeat_capacity=0, repeat_code=0, repeat_kill=-1;
    uint8_t containers[TEIA_MAX_CONTAINERS]={0};
    uint32_t i, delays=0; uint8_t assigned[TEIA_MAX_REGS] = {0}, states[TEIA_MAX_STATES] = {0};
    if (!p || !p->count || p->count > TEIA_MAX_OPS || !p->registers || p->registers > TEIA_MAX_REGS || p->value_count > TEIA_MAX_VALUES) return 0;
    for (i = 0; i < p->count; ++i) {
        const teia_op_t *o = &p->ops[i];
        if (o->code != 5 && o->code != 43 && o->code != 56 && o->code != 59 && o->code != 61 && !teia_reg(o->out, p->registers)) return 0;
        if (o->code == 0) {
            if (!teia_reg(o->a, p->value_count)) return 0;
        } else {
            int refs[9], n=0, stateful=0;
            refs[n++]=o->a;
            switch(o->code) {
            case 1: case 24: case 32: case 41: break;
            case 54:
                n=0;
                if(!teia_reg(o->a,TEIA_MAX_STATES) || states[o->a]!=4) return 0;
                if(repeat_end>=0 && (o->a<repeat_start || o->a>=repeat_start+repeat_states)) return 0;
                break;
            case 55:
                if(o->a<5 || o->a>9) return 0;
                n=0; refs[n++]=o->b; break;
            case 56: case 60:
                if(repeat_end>=0 || o->b<=(int)i || o->b>=(int)p->count || p->ops[o->b].code!=(o->code==56?59:61)) return 0;
                if(o->g<0 || o->g>=(int)TEIA_MAX_CONTAINERS || containers[o->g]++) return 0;
                if(o->e<0 || o->f<1 || o->f>(int)TEIA_MAX_INSTANCES || o->state<0 || o->state+o->e*o->f>(int)TEIA_MAX_STATES) return 0;
                for(int k=o->state;k<o->state+o->e*o->f;k++) if(states[k]) return 0;
                repeat_end=o->b; repeat_start=o->state; repeat_states=o->e; repeat_capacity=o->f; repeat_code=o->code; repeat_kill=o->c;
                if(o->code==60) { refs[n++]=o->d; if(o->c < -1 || (o->c>=0 && !teia_reg(o->c,p->registers))) return 0; }
                break;
            case 59: case 61:
                n=0;
                if((int)i!=repeat_end || o->code!=(repeat_code==56?59:61)) return 0;
                if(repeat_code==60 && repeat_kill>=0 && !assigned[repeat_kill]) return 0;
                repeat_end=-1; break;
            case 57: case 62:
                n=0;
                if(repeat_end<0 || (o->code==57 && repeat_code!=56) || (o->code==62 && repeat_code!=60)) return 0;
                break;
            case 58:
                if(repeat_end<0 || (o->b!=0 && o->b!=1)) return 0;
                break;
            case 63: stateful=1; break;
            case 52:
                if(o->a<0 || o->a>4) return 0;
                n=0; refs[n++]=o->b; break;
            case 2: case 21: case 22: case 23: case 33: case 34: case 35: case 36: refs[n++]=o->b; break;
            case 3: case 37: stateful=1; break;
            case 5: if(o->b!=0 && o->b!=1) return 0; break;
            case 42:
                n=0;
                if(!teia_reg(o->state,TEIA_MAX_STATES) || states[o->state]) return 0;
                if(repeat_end>=0 && (o->state<repeat_start || o->state>=repeat_start+repeat_states)) return 0;
                for(int k=0;k<(repeat_end>=0?repeat_capacity:1);k++) {
                    int at=o->state+k*repeat_states; if(states[at]) return 0; states[at]=2;
                }
                break;
            case 43:
                if(!teia_reg(o->state,TEIA_MAX_STATES) || states[o->state]!=2) return 0;
                if(repeat_end>=0 && (o->state<repeat_start || o->state>=repeat_start+repeat_states)) return 0;
                for(int k=0;k<(repeat_end>=0?repeat_capacity:1);k++) {
                    int at=o->state+k*repeat_states; if(states[at]!=2) return 0; states[at]=3;
                }
                break;
            case 19: case 20: case 27: case 29: case 30: case 31:
                refs[n++]=o->b; refs[n++]=o->c; stateful=1; break;
            case 28: refs[n++]=o->b; stateful=1; break;
            case 38: {
                int arity=teia_function_arity(o->d);
                if(!arity) return 0;
                if(arity>=2) refs[n++]=o->b;
                if(arity==3) refs[n++]=o->c;
                break;
            }
            case 39:
                if(o->f!=0 && o->f!=1) return 0;
                refs[n++]=o->b; refs[n++]=o->c; refs[n++]=o->d; refs[n++]=o->e;
                stateful=1; break;
            case 40:
                if(o->c < -1) return 0;
                refs[n++]=o->b; if(o->c>=0) refs[n++]=o->c;
                stateful=1; break;
            case 25:
                if((o->g<0 || (o->g>4 && o->g!=12)) || o->d < -1 || o->e < -1 || o->f < -1 || o->h < -1) return 0;
                refs[n++]=o->b; refs[n++]=o->c;
                if(o->d>=0) refs[n++]=o->d;
                if(o->e>=0) refs[n++]=o->e;
                if(o->f>=0) refs[n++]=o->f;
                if(o->g==4 && o->f<0) return 0;
                if(o->g==12 && (o->f<0 || o->h<0)) return 0;
                if(o->g==12) refs[n++]=o->h;
                stateful=1; break;
            case 26:
                refs[n++]=o->b; refs[n++]=o->c; refs[n++]=o->d; refs[n++]=o->e;
                refs[n++]=o->f; refs[n++]=o->g; refs[n++]=o->h; stateful=1; break;
            case TEIA_LEGACY_DELAY_OPCODE: case TEIA_DELAY_OPCODE:
                if(repeat_end>=0 || ++delays>TEIA_MAX_DELAYS) return 0;
                refs[n++]=o->b; refs[n++]=o->c; refs[n++]=o->d; stateful=1; break;
            case 45: refs[n++]=o->b; refs[n++]=o->c; stateful=1; break;
            case 46: refs[n++]=o->b; refs[n++]=o->c; refs[n++]=o->d; refs[n++]=o->e; break;
            case 47: refs[n++]=o->b; break;
            case 48: refs[n++]=o->b; refs[n++]=o->c; break;
            case 49:
                if(repeat_end>=0 || o->b<0 || o->b>19) return 0;
                refs[n++]=o->c; stateful=1; break;
            case 50: refs[n++]=o->b; stateful=1; break;
            case 51:
                if(o->g<0 || o->h<2 || o->g+2*o->h+2>=(int)p->value_count) return 0;
                refs[n++]=o->b; refs[n++]=o->c; refs[n++]=o->d; refs[n++]=o->e; refs[n++]=o->f;
                stateful=1; break;
            default: return 0;
            }
            for(int j=0;j<n;j++) if(!teia_reg(refs[j],p->registers) || !assigned[refs[j]]) return 0;
            if(stateful) {
                if(!teia_reg(o->state,TEIA_MAX_STATES) || states[o->state]) return 0;
                if(repeat_end>=0 && (o->state<repeat_start || o->state>=repeat_start+repeat_states)) return 0;
                for(int k=0;k<(repeat_end>=0?repeat_capacity:1);k++) {
                    int at=o->state+k*repeat_states;
                    if(states[at]) return 0;
                    states[at]=o->code==26?4:1;
                }
            }
        }
        if (o->code != 5 && o->code != 43 && o->code != 56 && o->code != 59 && o->code != 61) assigned[o->out] = 1;
    }
    if(repeat_end>=0) return 0;
    for(i=0;i<TEIA_MAX_STATES;i++) if(states[i]==2) return 0;
    return 1;
}
static void teia_schedule(teia_runtime_t *r)
{
    const teia_program_t *p=r->program;
    uint8_t assigned[TEIA_MAX_REGS]={0}, control[TEIA_MAX_REGS]={0};
    uint32_t i;
    r->control_count=r->audio_count=0;
    for(i=0;i<p->count;i++) if(p->ops[i].code==56 || p->ops[i].code==60) {
        for(i=0;i<p->count;i++) r->audio_ops[r->audio_count++]=(uint16_t)i;
        return;
    }
    /* The shared compiler emits single-assignment registers. Older/handmade
     * packages may overwrite registers; preserve their original order. */
    for(i=0;i<p->count;i++) {
        const teia_op_t *o=&p->ops[i];
        if(o->code==5 || o->code==43) continue;
        if(assigned[o->out]) {
            for(i=0;i<p->count;i++) r->audio_ops[r->audio_count++]=(uint16_t)i;
            return;
        }
        assigned[o->out]=1;
    }
    for(i=0;i<p->count;i++) {
        const teia_op_t *o=&p->ops[i]; int stable=0;
        switch(o->code) {
        case 0: stable=1; break;
        case 1: case 24: case 32: case 41: stable=control[o->a]; break;
        case 2: case 21: case 22: case 23: case 33: case 34: case 35: case 36: case 47:
            stable=control[o->a] && control[o->b]; break;
        case 38: {
            int arity=teia_function_arity(o->d);
            stable=control[o->a] && (arity<2 || control[o->b]) && (arity<3 || control[o->c]);
            break;
        }
        case 46:
            stable=control[o->a] && control[o->b] && control[o->c] && control[o->d] && control[o->e]; break;
        case 48: stable=control[o->a] && control[o->b] && control[o->c]; break;
        default: break;
        }
        if(o->code!=5 && o->code!=43) control[o->out]=(uint8_t)stable;
        if(stable) r->control_ops[r->control_count++]=(uint16_t)i;
        else r->audio_ops[r->audio_count++]=(uint16_t)i;
    }
}
static int teia_load(teia_runtime_t *r, const teia_program_t *p)
{
    uint32_t i, delays=0;
    if (!teia_validate(p)) return 0;
    r->program = p;
    r->controls_valid=0;
    for (i = 0; i < TEIA_MAX_VALUES; ++i) r->values[i] = p->values[i];
    for (i = 0; i < TEIA_MAX_REGS; ++i) r->regs[i] = 0;
    for (i = 0; i < TEIA_MAX_STATES; ++i) r->feedback[i] = 0;
    for (i = 0; i < TEIA_MAX_DELAYS; ++i) {
        r->delay_state[i].position = r->delay_state[i].filled = r->delay_state[i].time = 0;
        r->delay_state[i].ready = 0;
    }
    for (i = 0; i < TEIA_MAX_STATES; ++i) r->delay_slot[i] = -1;
    for (i = 0; i < p->count; ++i) {
        if (p->ops[i].code == TEIA_DELAY_OPCODE || p->ops[i].code == TEIA_LEGACY_DELAY_OPCODE)
            r->delay_slot[p->ops[i].state] = (int8_t)delays++;
    }
    r->midi_note = r->midi_frequency = r->midi_velocity = r->midi_gate = r->midi_trigger = 0;
    r->midi_trigger_pending = 0;
    r->event_read=r->event_write=r->event_count=0; r->event_active=r->event_gap=r->event_overflow=0;
    r->repeat_offset=r->repeat_item=0; r->repeat_gate=0; r->block_start=1;
    for(i=0;i<TEIA_MAX_CONTAINERS;i++) r->repeats[i]=(teia_repeat_t){.trigger=0};
    for (i = 0; i < TEIA_MAX_STATES; ++i) {
        r->state[i].level = r->state[i].start = 0;
        r->state[i].elapsed = r->state[i].duration = r->state[i].phase = 0;
        r->state[i].ended = r->state[i].gate = r->state[i].stage = r->state[i].trigger = r->state[i].coeff_valid = 0;
        r->state[i].x1 = r->state[i].x2 = r->state[i].y1 = r->state[i].y2 = 0;
        r->state[i].progress_duration=0;
    }
    for (i=0;i<p->count;i++) {
        if(p->ops[i].code==28 || p->ops[i].code==40) r->state[p->ops[i].state].phase=0x9e3779b9u ^ ((uint32_t)p->ops[i].state*0x85ebca6bu);
    }
    teia_schedule(r);
    return 1;
}
static int32_t teia_clamp(int32_t x, int32_t lo, int32_t hi) { return x < lo ? lo : x > hi ? hi : x; }
static int32_t teia_dsp_bound(int32_t x) { return teia_clamp(x, -TEIA_DSP_LIMIT, TEIA_DSP_LIMIT); }
static int32_t teia_mul(int32_t a, int32_t b)
{
    /* Cable weights are commonly zero or unity. Keep neutral routing out of
     * the wide multiply path without changing fixed-point rounding. */
    if (!a || !b) return 0;
    if (a == TEIA_Q) return b;
    if (b == TEIA_Q) return a;
    int64_t v = ((int64_t)a * b) >> 16;
    return v > 2147483647 ? 2147483647 : v < (-2147483647 - 1) ? (-2147483647 - 1) : (int32_t)v;
}
static uint32_t teia_duration(int32_t t, int attack)
{
    uint32_t n = (uint32_t)(((int64_t)teia_clamp(t, 0, 2 * TEIA_Q) * TEIA_FS) >> 16);
    return attack && n < 45 ? 45 : n; /* Teia's minimum attack is 1 ms. */
}
static int32_t teia_envelope(teia_state_t *s, int32_t gate, int32_t attack, int32_t release)
{
    uint32_t on = gate >= TEIA_Q / 2;
    if (on != s->gate) {
        s->start = s->level; s->elapsed = 0;
        s->duration = teia_duration(on ? attack : release, on);
        s->stage = on ? 1 : 2;
    }
    s->gate = (uint8_t)on;
    if (s->stage) {
        if (++s->elapsed >= s->duration) {
            s->level = on ? TEIA_Q : 0; s->stage = 0;
        } else {
            /* First divide in 32 bits; the remainder product also fits below 2^32. */
            uint32_t n = s->elapsed, d = s->duration;
            uint32_t progress = n / d * TEIA_Q + (n % d) * (TEIA_Q / 2) / d * 2;
            s->level = on ? s->start + teia_mul(TEIA_Q - s->start, (int32_t)progress)
                          : teia_mul(s->start, TEIA_Q - (int32_t)progress);
        }
    }
    return s->level;
}
static int32_t teia_sine(teia_state_t *s, int32_t frequency)
{
    uint32_t f = (uint32_t)teia_clamp(frequency, 0, 20000 * TEIA_Q);
    uint32_t i = s->phase >> 22, fraction = (s->phase >> 7) & 32767u;
    int32_t a = sine_table[i], b = sine_table[i + 1u];
    int32_t value = (a + (b - a) * (int32_t)fraction / 32768) * 2;
    s->phase += (f / TEIA_FS) * 65536u + ((f % TEIA_FS) * 65536u) / TEIA_FS;
    return value;
}
/* Linear mapping of the bipolar sine into either ordered or inverted endpoints.
 * Widen before subtracting: even the full signed Q16.16 span fits in int64. */
static int32_t teia_range(int32_t sine, int32_t low, int32_t high)
{
    return (int32_t)((int64_t)low + (((int64_t)high - low) * ((int64_t)sine + TEIA_Q) >> 17));
}
/* Saturating arithmetic; intermediates never overflow signed 32-bit values. */
static int32_t teia_sat(int64_t v)
{ return v > INT32_MAX ? INT32_MAX : v < INT32_MIN ? INT32_MIN : (int32_t)v; }
static uint32_t teia_abs(int32_t x) { return x < 0 ? 0u - (uint32_t)x : (uint32_t)x; }
/* Fractional division without a software 64-bit division in the audio ISR. */
static uint32_t teia_fraction(uint32_t n, uint32_t d, unsigned bits)
{
    uint32_t result = n / d, remainder = n % d;
    while (bits--) {
        result <<= 1;
        /* remainder*2 can overflow for arbitrary Q16 divisors. */
        if (remainder >= d - remainder) { remainder -= d - remainder; result |= 1; }
        else remainder += remainder;
    }
    return result;
}
static int32_t teia_div(int32_t a, int32_t b)
{
    uint32_t n, d, whole, magnitude; int negative = (a < 0) != (b < 0);
    if (!b) return 0;
    n=teia_abs(a); d=teia_abs(b); whole=n/d;
    if (whole >= 32768u) return negative ? INT32_MIN : INT32_MAX;
    /* Exact signed/truncating division for the common set-link denominators;
     * averaging two audio paths must not run a 16-step fractional divider. */
    if (d == TEIA_Q) magnitude=n;
    else if (d == 2u*TEIA_Q) magnitude=n>>1;
    else magnitude=teia_fraction(n,d,16);
    return negative ? -(int32_t)magnitude : (int32_t)magnitude;
}
static uint32_t teia_seconds(int32_t seconds, int attack)
{
    uint32_t n=(uint32_t)(((int64_t)teia_clamp(seconds,0,60*TEIA_Q)*TEIA_FS)>>16);
    return attack && n < 45 ? 45 : n;
}
static int32_t teia_progress(uint32_t elapsed, uint32_t duration)
{ return !duration || elapsed >= duration ? TEIA_Q : (int32_t)teia_fraction(elapsed,duration,16); }
/* Exact quotient/remainder ramp for unchanged durations. This is the same
 * floor(elapsed*65536/duration) as teia_progress, without its 16-step division
 * on every sample. Recompute immediately for modulated time or a retrigger.
 * Durations come from teia_seconds and are bounded to 60*TEIA_FS. */
static int32_t teia_progress_cached(teia_state_t *s, uint32_t duration)
{
    if(!duration || s->elapsed>=duration) return TEIA_Q;
    if(s->progress_duration==duration && s->elapsed==s->progress_elapsed+1) {
        s->progress_value+=s->progress_step;
        s->progress_remainder+=s->progress_step_remainder;
        if(s->progress_remainder>=duration) {
            s->progress_remainder-=duration;
            ++s->progress_value;
        }
    } else {
        s->progress_duration=duration;
        s->progress_step=TEIA_Q/duration;
        s->progress_step_remainder=TEIA_Q%duration;
        s->progress_value=(uint32_t)teia_progress(s->elapsed,duration);
        s->progress_remainder=(uint32_t)(((uint64_t)s->elapsed<<16)-(uint64_t)s->progress_value*duration);
    }
    s->progress_elapsed=s->elapsed;
    return (int32_t)s->progress_value;
}
static int32_t teia_adsr(teia_state_t *s, const teia_op_t *o, const int32_t *v)
{
    int gate=v[o->a]>=TEIA_Q/2, trigger=v[o->f]>=TEIA_Q/2;
    s->ended=0;
    int32_t sustain=teia_clamp(v[o->d],0,TEIA_Q), p;
    if ((gate && !s->gate) || (trigger && !s->trigger)) {
        s->start=s->level; s->elapsed=0; s->stage=v[o->g]>0 ? 5 : 1;
    } else if (!gate && s->gate) { s->start=s->level; s->elapsed=0; s->stage=4; }
    s->gate=(uint8_t)gate; s->trigger=(uint8_t)trigger;
    if (s->elapsed < 60u*TEIA_FS+1u) ++s->elapsed;
    switch(s->stage) {
    case 5:
        if(s->elapsed>=teia_seconds(v[o->g],0)) { s->stage=1; s->elapsed=0; }
        break;
    case 1:
        p=teia_progress_cached(s,teia_seconds(v[o->b],1));
        s->level=s->start+teia_mul(TEIA_Q-s->start,p);
        if(p==TEIA_Q) { s->stage=2; s->elapsed=0; }
        break;
    case 2:
        p=teia_progress_cached(s,teia_seconds(v[o->c],0));
        s->level=TEIA_Q+teia_mul(sustain-TEIA_Q,p);
        if(p==TEIA_Q) { s->stage=gate?3:(v[o->h]>0?6:4); s->start=s->level; s->elapsed=0; }
        break;
    case 3: s->level=sustain; break;
    case 6:
        s->level=sustain;
        if(s->elapsed>=teia_seconds(v[o->h],0)) { s->stage=4; s->start=s->level; s->elapsed=0; }
        break;
    case 4:
        p=teia_progress_cached(s,teia_seconds(v[o->e],0));
        s->level=teia_mul(s->start,TEIA_Q-p);
        if(p==TEIA_Q) { s->level=0; s->stage=0; s->ended=1; }
        break;
    default: s->level=0; break;
    }
    return s->level;
}
static uint32_t teia_increment(int32_t frequency)
{
    uint32_t f=(uint32_t)teia_clamp(frequency,0,20000*TEIA_Q);
    return f/TEIA_FS*65536u+(f%TEIA_FS)*65536u/TEIA_FS;
}
static int32_t teia_wave(uint32_t phase, int wave, int32_t width)
{
    int32_t p=(int32_t)(phase>>16);
    switch(wave) {
    case 1: { uint32_t t=phase+0x40000000u; int32_t q=(int32_t)(t>>16);
        return q<32768 ? q*4-TEIA_Q : 3*TEIA_Q-q*4; }
    case 2: return p*2-TEIA_Q;
    case 3: return TEIA_Q-p*2;
    case 4: return p<teia_clamp(width,0,TEIA_Q) ? TEIA_Q : -TEIA_Q;
    default: { uint32_t i=phase>>22, fraction=(phase>>7)&32767u;
        return (sine_table[i]+(sine_table[i+1]-sine_table[i])*(int32_t)fraction/32768)*2; }
    }
}
static int32_t teia_bend(int32_t exponent);
static int32_t teia_log2_q(int32_t value);
/* Bounded Q16.16 sign-preserving power, matching the browser kernel:
 * sign(base) * abs(base)^exponent. */
static int32_t teia_pow_q(int32_t base, int32_t exponent)
{
    int negative=base<0; int32_t factor, scaled;
    /* Pow's default exponent is the identity. Avoid the per-sample logarithm
     * and exponent table entirely, and preserve the input exactly like WASM. */
    if(exponent==TEIA_Q) return base;
    if(!exponent) return base<0 ? -TEIA_Q : base>0 ? TEIA_Q : 0;
    factor=negative?teia_sat(-(int64_t)base):base;
    if(!factor) return 0;
    /* log2 plus the existing interpolated exp2 table is constant-work per
     * sample, unlike a chain of fractional square roots. */
    scaled=teia_mul(exponent,teia_log2_q(factor));
    return negative?teia_sat(-(int64_t)teia_bend(scaled)):teia_bend(scaled);
}
static int32_t teia_kink(uint32_t phase, int32_t shape, int32_t squareness)
{
    int32_t p=(int32_t)(phase>>16), amount=teia_clamp(squareness,-TEIA_Q,TEIA_Q);
    int32_t magnitude=(int32_t)teia_abs(amount), q=(TEIA_Q-teia_clamp(shape,-TEIA_Q,TEIA_Q))/2;
    int ascending, u, straight, curved_position, curved, exponent;
    if(magnitude>=TEIA_Q) { int high=p>=q; return high==(amount>0)?TEIA_Q:-TEIA_Q; }
    if(q<=0) { ascending=0; u=p; }
    else if(q>=TEIA_Q) { ascending=1; u=p; }
    else if(p<=q) { ascending=1; u=teia_div(p,q); }
    else { ascending=0; u=teia_div(p-q,TEIA_Q-q); }
    u=teia_clamp(u,0,TEIA_Q); straight=ascending?-TEIA_Q+2*u:TEIA_Q-2*u;
    exponent=TEIA_Q+teia_mul(11*TEIA_Q,magnitude)/(TEIA_Q-magnitude);
    curved_position=amount>=0?teia_pow_q(u,exponent):TEIA_Q-teia_pow_q(TEIA_Q-u,exponent);
    curved=ascending?-TEIA_Q+2*curved_position:TEIA_Q-2*curved_position;
    return teia_sat((int64_t)straight+teia_mul(curved-straight,magnitude));
}
static int32_t teia_osc(teia_state_t *s, const teia_op_t *o, const int32_t *v)
{
    int reset=o->e>=0 && v[o->e]>=TEIA_Q/2;
    int32_t phase=o->d>=0 ? v[o->d] : 0, width=o->f>=0 ? v[o->f] : TEIA_Q/2;
    /* Match the browser's short phase-reset crossfade before mapping to range. */
    if(reset && !s->gate) {
        s->start=o->g==12 ? teia_kink(s->phase+((uint32_t)phase<<16),v[o->f],v[o->h]) : teia_wave(s->phase+((uint32_t)phase<<16),o->g,width);
        s->elapsed=0; s->stage=1; s->phase=0;
    }
    s->gate=(uint8_t)reset;
    /* Casting before shifting gives defined modulo-one handling of negative offsets. */
    int32_t sample=o->g==12 ? teia_kink(s->phase+((uint32_t)phase<<16),v[o->f],v[o->h]) : teia_wave(s->phase+((uint32_t)phase<<16),o->g,width);
    if(s->stage) { /* 8 ms at the FM-1's 44.1 kHz render rate. */
        int32_t progress=(int32_t)(((uint64_t)s->elapsed*TEIA_Q)/353u);
        int32_t squared=teia_mul(progress,progress);
        int32_t mix=teia_mul(squared,3*TEIA_Q-2*progress);
        sample=s->start+teia_mul(sample-s->start,mix);
        if(++s->elapsed>=353u) s->stage=0;
    }
    s->phase+=teia_increment(v[o->a]);
    return teia_range(sample,v[o->b],v[o->c]);
}
static int32_t teia_noise(teia_state_t *s, int32_t lo, int32_t hi)
{
    uint32_t x=s->phase;
    x^=x<<13; x^=x>>17; x^=x<<5; s->phase=x;
    return teia_range((int32_t)(x>>15)-TEIA_Q,lo,hi);
}
static int32_t teia_sin30(uint32_t phase)
{
    uint32_t i=phase>>22, fraction=phase&0x3fffffu;
    return filter_sine[i]+(int32_t)(((int64_t)filter_sine[i+1]-filter_sine[i])*fraction>>22);
}
/* RBJ low/high/band/all-pass biquad. Q28 coefficients, Q16 signal history, cached by cutoff/Q.
 * Q is limited to 0.25..16; coefficient calculation uses bounded integer division.
 * As in the browser, cutoff is Hz and resonance is Q, not a 0..1 wet amount. */
static int32_t teia_biquad(teia_state_t *s, int32_t input, int32_t cutoff, int32_t q, int mode)
{
    const int32_t one=268435456;
    cutoff=teia_clamp(cutoff,20*TEIA_Q,19845*TEIA_Q); q=teia_clamp(q,TEIA_Q/4,16*TEIA_Q);
    if(s->coeff_valid!=mode || s->cutoff!=cutoff || s->q!=q) {
        uint32_t phase=teia_increment(cutoff);
        int32_t sine=teia_sin30(phase)>>2, cosine=teia_sin30(phase+0x40000000u)>>2;
        /* sine/(2Q), keeping Q28 precision without a 64-bit divide. */
        uint32_t alpha=teia_fraction((uint32_t)sine,(uint32_t)q*2u,16);
        uint32_t denominator=(uint32_t)one+alpha;
        s->coeff[3]=(int32_t)teia_fraction(teia_abs(cosine)*2u,denominator,28)*(cosine>=0?-1:1);
        s->coeff[4]=(int32_t)teia_fraction(teia_abs(one-(int32_t)alpha),denominator,28)*(alpha>(uint32_t)one?-1:1);
        if(mode==8) { /* All-pass: reverse the normalised denominator. */
            s->coeff[0]=s->coeff[4]; s->coeff[1]=s->coeff[3]; s->coeff[2]=one;
        } else if(mode==3) { /* Constant 0 dB peak band-pass, matching the browser. */
            s->coeff[0]=(int32_t)teia_fraction(alpha,denominator,28);
            s->coeff[1]=0; s->coeff[2]=-s->coeff[0];
        } else {
            uint32_t numerator=(uint32_t)(mode==2 ? one+cosine : one-cosine)/2u;
            s->coeff[0]=(int32_t)teia_fraction(numerator,denominator,28);
            s->coeff[1]=s->coeff[0]*(mode==2 ? -2 : 2); s->coeff[2]=s->coeff[0];
        }
        s->cutoff=cutoff; s->q=q; s->coeff_valid=(uint8_t)mode;
    }
    int64_t sum=(int64_t)s->coeff[0]*input+(int64_t)s->coeff[1]*s->x1+(int64_t)s->coeff[2]*s->x2
        -(int64_t)s->coeff[3]*s->y1-(int64_t)s->coeff[4]*s->y2;
    int32_t result=teia_sat(sum>>28);
    s->x2=s->x1; s->x1=input; s->y2=s->y1; s->y1=result;
    return result;
}

/* Keep the driven value wide until folding: saturating first destroys the wraps.
 * Split the positive gain into whole/fractional parts so even Fold's full Q16
 * amount range cannot overflow the signed 64-bit product. */
static int32_t teia_fold(int32_t input, int64_t gain)
{
    int64_t driven=(int64_t)input*(gain>>16)+(((int64_t)input*(gain&65535))>>16);
    uint32_t wrapped=((uint32_t)driven+TEIA_Q)&(4u*TEIA_Q-1u);
    return wrapped<=2u*TEIA_Q ? (int32_t)wrapped-TEIA_Q : 3*TEIA_Q-(int32_t)wrapped;
}
static int32_t teia_distortion(int32_t input, int32_t drive, int code)
{
    drive=teia_clamp(drive,6554,40*TEIA_Q); /* 0.1..40, as in the browser. */
    if(code==36) return teia_fold(input,drive);
    int32_t driven=teia_clamp(teia_mul(input,drive),-32*TEIA_Q,32*TEIA_Q);
    if(code==34) return teia_clamp(driven,-TEIA_Q,TEIA_Q);
    return teia_div(driven,TEIA_Q+(int32_t)teia_abs(driven));
}
/* 10 Hz one-pole DC blocker at 44.1 kHz. Q24 history reduces the DC
 * quantisation floor; input and output are bounded to +/-4 like the browser. */
static int32_t teia_dc_block(teia_state_t *s, int32_t input)
{
    const int32_t pole=268053273; /* round(exp(-2*pi*10/44100) * 2^28) */
    int32_t x=teia_clamp(input,-4*TEIA_Q,4*TEIA_Q)*256;
    int32_t y=teia_clamp(x-s->x1+(int32_t)(((int64_t)pole*s->y1)>>28),
        -4*TEIA_Q*256,4*TEIA_Q*256);
    s->x1=x; s->y1=y;
    return y/256;
}

static int32_t teia_function(int id, int32_t x, int32_t y, int32_t z)
{
    int32_t fraction=(int32_t)((uint32_t)x&65535u);
    switch(id) {
    case 1: return teia_sat((int64_t)teia_abs(x));
    case 6: return x<y?x:y;
    case 7: return x>y?x:y;
    case 8: return teia_clamp(x,y<z?y:z,y>z?y:z);
    case 13: return x-fraction;
    case 14: return teia_sat((int64_t)x-fraction+(fraction?TEIA_Q:0));
    case 15: { /* Nearest integer, ties away from zero like Rust f64::round. */
        int64_t magnitude=((int64_t)teia_abs(x)+TEIA_Q/2)/TEIA_Q*TEIA_Q;
        return teia_sat(x<0?-magnitude:magnitude);
    }
    case 16: return x>0?TEIA_Q:x<0?-TEIA_Q:0;
    case 17: return fraction;
    case 19: return x<y?TEIA_Q:0;
    case 20: return x<=y?TEIA_Q:0;
    case 21: return x>y?TEIA_Q:0;
    case 22: return x>=y?TEIA_Q:0;
    case 23: return x==y?TEIA_Q:0;
    case 24: return x!=y?TEIA_Q:0;
    case 25: return x && y?TEIA_Q:0;
    case 26: return x || y?TEIA_Q:0;
    case 27: return x?0:TEIA_Q;
    default: return 0;
    }
}
static int32_t teia_accumulator(teia_state_t *s, const teia_op_t *o, const int32_t *v)
{
    int trigger=v[o->a]>=TEIA_Q/2, reset=v[o->e]>=TEIA_Q/2;
    int32_t low=v[o->b]<v[o->c]?v[o->b]:v[o->c], high=v[o->b]>v[o->c]?v[o->b]:v[o->c];
    int32_t value=teia_clamp(s->level,low,high);
    if(reset && !s->gate) value=low;
    else if(o->f || (trigger && !s->trigger)) {
        int64_t next=(int64_t)value+v[o->d];
        value=next>high?low:next<low?high:(int32_t)next;
    }
    s->gate=(uint8_t)reset; s->trigger=(uint8_t)trigger; s->level=value;
    return value;
}
static int32_t teia_random(teia_state_t *s, int trigger, int32_t low, int32_t high)
{
    if(!s->stage || (trigger && !s->trigger)) {
        s->level=teia_noise(s,-TEIA_Q,TEIA_Q); s->stage=1;
    }
    s->trigger=(uint8_t)trigger;
    return teia_range(s->level,low,high);
}

/* 2^exponent, using a Q2.30 fractional-octave table and linear interpolation.
 * Q16.16 output rounds to nearest and saturates; no floating point or libm.
 * Integer exponents are exact while representable. */
static int32_t teia_bend(int32_t exponent)
{
    if (!exponent) return TEIA_Q;
    if (exponent >= 15 * TEIA_Q) return INT32_MAX;
    if (exponent < -17 * TEIA_Q) return 0;
    int whole = exponent / TEIA_Q;
    int fraction = exponent % TEIA_Q;
    if (fraction < 0) { --whole; fraction += TEIA_Q; }
    unsigned index = (unsigned)fraction >> 8;
    uint64_t ratio = bend_ratio_table[index];
    ratio += ((uint64_t)(bend_ratio_table[index + 1] - bend_ratio_table[index])
        * ((unsigned)fraction & 255u) + 128u) >> 8;
    unsigned shift = (unsigned)(14 - whole);
    if (!shift) return (int32_t)ratio;
    return (int32_t)((ratio + ((uint64_t)1 << (shift - 1))) >> shift);
}

static int32_t teia_map(int32_t signal, int32_t src_min, int32_t src_max, int32_t target_min, int32_t target_max)
{
    int32_t denominator=teia_sat((int64_t)src_max-src_min);
    if(!denominator) denominator=TEIA_Q;
    return teia_sat((int64_t)target_min+teia_mul(teia_div(teia_sat((int64_t)signal-src_min),denominator),teia_sat((int64_t)target_max-target_min)));
}
static int32_t teia_follower(teia_state_t *s, int32_t signal, int32_t attack, int32_t release)
{
    int32_t target=teia_sat((int64_t)teia_abs(signal)), seconds=target>s->level?attack:release;
    uint32_t duration=teia_seconds(seconds,0); int32_t coefficient=!duration?TEIA_Q:(int32_t)teia_fraction(1,duration,16);
    s->level=teia_sat((int64_t)s->level+teia_mul(target-s->level,coefficient));
    return s->level<0?0:s->level;
}
/* Signed 16-bit / 4096 storage preserves ±8 headroom. Round to nearest,
 * ties away from zero; saturate before the cast so +8 cannot wrap negative. */
static int16_t teia_delay_pack(int32_t sample)
{
    const int32_t scale = 1 << (16 - TEIA_DELAY_FRACTION_BITS);
    sample = teia_clamp(sample, -8*TEIA_Q, 8*TEIA_Q);
    sample = sample < 0 ? -((-sample + scale/2)/scale) : (sample + scale/2)/scale;
    return (int16_t)teia_clamp(sample, -32768, 32767);
}
static int32_t teia_delay_read(const teia_runtime_t *r, uint32_t slot, uint32_t age, int32_t input)
{
    const teia_delay_state_t *s = &r->delay_state[slot];
    uint32_t index;
    /* For 0–1 sample delays, interpolate from current dry input. This makes
     * smoothing into/out of zero continuous without an algebraic feedback loop. */
    if (!age) return input;
    if (age > s->filled) return 0;
    index = s->position >= age ? s->position-age : s->position+TEIA_MAX_DELAY_SAMPLES-age;
    return (int32_t)r->delay[slot][index] * (1 << (16 - TEIA_DELAY_FRACTION_BITS));
}
static int32_t teia_delay(teia_runtime_t *r, uint32_t state, int32_t input, int32_t time, int32_t feedback, int32_t mix)
{
    int slot = r->delay_slot[state];
    int32_t sample = teia_clamp(input, -8*TEIA_Q, 8*TEIA_Q), delayed, newer, older, stored;
    uint32_t target, whole, fraction;
    teia_delay_state_t *s;
    if (slot < 0 || slot >= (int)TEIA_MAX_DELAYS) return sample;
    s = &r->delay_state[slot];
    /* Unsigned Q16.16 sample position: one second exceeds signed int32. */
    target = (uint32_t)teia_clamp(time, 0, TEIA_Q) * TEIA_FS;
    if (!s->ready) { s->time = target; s->ready = 1; }
    else if (target > s->time)
        s->time += (target-s->time+TEIA_DELAY_SMOOTHING_SAMPLES-1u)/TEIA_DELAY_SMOOTHING_SAMPLES;
    else if (target < s->time)
        s->time -= (s->time-target+TEIA_DELAY_SMOOTHING_SAMPLES-1u)/TEIA_DELAY_SMOOTHING_SAMPLES;
    whole = s->time >> 16;
    fraction = s->time & 65535u;
    newer = teia_delay_read(r, (uint32_t)slot, whole, sample);
    older = fraction ? teia_delay_read(r, (uint32_t)slot, whole+1u, sample) : newer;
    delayed = newer + teia_mul(older-newer, (int32_t)fraction);
    stored = sample;
    if (s->time) {
        /* Fade feedback out below one sample, reaching the exact zero-time
         * bypass write smoothly even with feedback above unity. */
        int32_t gain = teia_clamp(feedback, 0, 2*TEIA_Q);
        if (s->time < TEIA_Q) gain = teia_mul(gain, (int32_t)s->time);
        stored = teia_clamp(sample + teia_mul(delayed, gain), -8*TEIA_Q, 8*TEIA_Q);
    }
    r->delay[slot][s->position] = teia_delay_pack(stored);
    if (++s->position == TEIA_MAX_DELAY_SAMPLES) s->position = 0;
    if (s->filled < TEIA_MAX_DELAY_SAMPLES-1u) ++s->filled;
    if (!s->time) return sample;
    mix = teia_clamp(mix, 0, TEIA_Q);
    return teia_clamp(teia_mul(sample, TEIA_Q-mix) + teia_mul(delayed, mix), -8*TEIA_Q, 8*TEIA_Q);
}
static int32_t teia_sample_hold(teia_state_t *s, int32_t signal, int32_t trigger)
{
    int on=trigger>=TEIA_Q/2;
    if(!s->stage || (on&&!s->trigger)) { s->level=signal; s->stage=1; }
    s->trigger=(uint8_t)on; return s->level;
}
static int32_t teia_tempo(teia_state_t *s, int32_t bpm, int kind, int32_t swing)
{
    static const uint32_t divisions[10]={16,8,4,4,2,1,1,2,4,8};
    uint32_t increment=(uint32_t)(((uint64_t)teia_clamp(bpm,TEIA_Q,999*TEIA_Q)*65536u)/(60u*TEIA_FS));
    uint32_t previous=s->phase; uint32_t division=divisions[kind%10], current;
    uint64_t before, after; (void)swing; s->phase+=increment; current=s->phase;
    if(current<previous) ++s->elapsed;
    if(kind>=10) return teia_sat((int64_t)teia_clamp(bpm,TEIA_Q,999*TEIA_Q)/(60*(int32_t)division));
    if(!s->stage) { s->stage=1; return kind==6?0:TEIA_Q; }
    if(kind<=5) return current<previous && s->elapsed%division==0 ? TEIA_Q : 0;
    if(kind==6) return previous<0x80000000u && current>=0x80000000u ? TEIA_Q : 0;
    before=(uint64_t)previous*division; after=(uint64_t)current*division;
    return before>>32 != after>>32 ? TEIA_Q : 0;
}
static int32_t teia_log2_q(int32_t value)
{
    int whole=0; uint32_t x; int32_t fraction=0; uint32_t bit;
    if(value<=0) return INT32_MIN;
    x=(uint32_t)value;
    while(x<TEIA_Q) { x<<=1; --whole; }
    while(x>=2u*TEIA_Q) { x>>=1; ++whole; }
    for(bit=0x8000u;bit;bit>>=1) { x=(uint32_t)(((uint64_t)x*x)>>16); if(x>=2u*TEIA_Q) { x>>=1; fraction|=(int32_t)bit; } }
    return whole*TEIA_Q+fraction;
}
static int32_t teia_quantise(int32_t frequency, int32_t scale, int32_t root)
{
    static const uint16_t masks[16]={0xfff,0xab5,0x5ad,0x9ad,0x6ad,0x295,0x4a9,0x469,0x6ad,0x5ab,0xad5,0x6b5,0x56b,0x555,0xb6d,0x6db};
    int sign=frequency<0?-1:1, note, nearest=0, distance=INT32_MAX, candidate, octave, semitone, root_note, centre;
    if(!frequency) return 0;
    note=69*TEIA_Q+12*teia_log2_q(teia_div((int32_t)teia_abs(frequency),440*TEIA_Q));
    root_note=((root+TEIA_Q/2)/TEIA_Q)%12; if(root_note<0) root_note+=12;
    centre=(note/TEIA_Q-root_note)/12;
    for(octave=centre-1;octave<=centre+1;octave++) for(semitone=0;semitone<12;semitone++) if(masks[teia_clamp((scale+TEIA_Q/2)/TEIA_Q,0,15)]&(1u<<semitone)) {
        candidate=(root_note+octave*12+semitone)*TEIA_Q;
        if((int32_t)teia_abs(candidate-note)<=distance) { distance=(int32_t)teia_abs(candidate-note); nearest=candidate; }
    }
    return sign*teia_mul(440*TEIA_Q,teia_bend(teia_div(nearest-69*TEIA_Q,12*TEIA_Q)));
}
static int32_t teia_custom_wave(teia_state_t *s, const teia_op_t *o, const int32_t *v, const int32_t *values)
{
    int32_t mode=values[o->g]/TEIA_Q, sustain_start=values[o->g+1], sustain_end=values[o->g+2];
    int32_t normalized=0, endpoint=v[o->d], phase=(int32_t)(s->phase>>16); uint32_t increment=teia_increment(v[o->a]);
    int trigger=v[o->c]>=TEIA_Q/2; int point;
    if(trigger&&!s->trigger) { s->phase=0; s->gate=0; s->stage=0; }
    s->trigger=(uint8_t)trigger; endpoint=teia_clamp(endpoint,-TEIA_Q,TEIA_Q);
    for(point=1;point<o->h;point++) {
        int32_t x0=values[o->g+3+2*(point-1)], y0=point==1?endpoint:values[o->g+4+2*(point-1)];
        int32_t x1=values[o->g+3+2*point], y1=point==o->h-1?endpoint:values[o->g+4+2*point];
        if(phase<=x1 || point==o->h-1) { normalized=x1==x0?y1:y0+teia_mul(y1-y0,teia_div(phase-x0,x1-x0)); break; }
    }
    if(mode==1 || mode==5) { if(!s->gate) { s->phase+=increment; if(s->phase>=UINT32_MAX) { s->phase=UINT32_MAX-(s->phase-UINT32_MAX); s->gate=1; } } else { s->phase-=increment; if((int32_t)s->phase<=0) { s->phase=0u-(uint32_t)(int32_t)s->phase; s->gate=0; } } }
    else if(mode==2) { if(!s->stage) { s->phase+=increment; if(s->phase<increment) s->stage=1; } }
    else if(mode==3 || mode==4) { if(s->phase>>16 < (uint32_t)sustain_start) s->phase+=increment; else s->phase=(uint32_t)sustain_start<<16; }
    else s->phase+=increment;
    (void)sustain_end;
    return teia_range(normalized,v[o->e],v[o->f]);
}

/* Events are consumed once globally, with a zero sample between events. */
static int teia_queue_note(teia_runtime_t *r, uint8_t channel, uint8_t note, uint8_t velocity, uint8_t on)
{
    if(channel<1 || channel>16 || note>127 || velocity>127) return 0;
    if(r->event_count==TEIA_EVENT_QUEUE) { ++r->rejected; r->event_read=r->event_write=r->event_count=0; r->event_overflow=1; return 0; }
    r->events[r->event_write]=(teia_note_event_t){note,velocity,channel,on};
    r->event_write=(r->event_write+1)%TEIA_EVENT_QUEUE; ++r->event_count; return 1;
}
static void teia_reset_instance(teia_runtime_t *r, const teia_op_t *begin, unsigned item)
{
    unsigned start=begin->state+item*begin->e;
    for(unsigned k=0;k<(unsigned)begin->e;k++) {
        r->state[start+k]=(teia_state_t){0}; r->feedback[start+k]=0;
    }
    /* Noise/random use a deterministic nonzero seed per independent instance. */
    for(unsigned k=0;k<r->program->count;k++) {
        const teia_op_t *o=&r->program->ops[k];
        if((o->code==28 || o->code==40) && o->state>=begin->state && o->state<begin->state+begin->e)
            r->state[o->state+item*begin->e].phase=0x9e3779b9u ^ ((o->state+item*begin->e)*0x85ebca6bu);
    }
}
static void teia_run_ops(teia_runtime_t *r, const uint16_t *indices, uint32_t count, int64_t *left, int64_t *right)
{
    uint32_t i;
    for (i = 0; i < count; ++i) {
        teia_op_t local = r->program->ops[indices[i]];
        const teia_op_t *o = &local; int32_t *v = r->regs;
        local.state += r->repeat_offset;
        if(local.code==54) local.a += r->repeat_offset;
        switch (o->code) {
        case 56: case 60: {
            teia_repeat_t *repeat=&r->repeats[o->g]; unsigned end=(unsigned)o->b, active=0;
            /* Repeat programs retain original instruction order, so i and end
             * are absolute here. Recursive calls contain no brackets. */
            for(unsigned k=i+1;k<end;k++) {
                const teia_op_t *collect=&r->program->ops[indices[k]];
                if(collect->code==58) v[collect->out]=collect->b?TEIA_Q:0;
            }
            if(o->code==60) {
                int trigger=v[o->a]>=TEIA_Q/2, release=v[o->d]>=TEIA_Q/2;
                if(release && !repeat->release) for(int k=0;k<o->f;k++)
                    if(repeat->active[k] && repeat->tags[k]==v[o->d]) repeat->gates[k]=0;
                if(trigger && !repeat->trigger) {
                    int k; for(k=0;k<o->f;k++) if(!repeat->active[k]) break;
                    if(k<o->f) {
                        teia_reset_instance(r,o,(unsigned)k);
                        repeat->active[k]=repeat->gates[k]=1; repeat->kills[k]=0; repeat->tags[k]=v[o->a];
                    } else ++r->rejected;
                }
                repeat->trigger=(uint8_t)trigger; repeat->release=(uint8_t)release;
            } else {
                unsigned requested=(unsigned)teia_clamp(v[o->a]/TEIA_Q,0,o->f);
                /* Boundary set-link averaging must use the rendered count,
                 * including a capacity reduced by the shared state budget. */
                v[o->a]=(int32_t)requested*TEIA_Q;
                for(unsigned k=requested;k<repeat->count;k++) teia_reset_instance(r,o,k);
                for(unsigned k=repeat->count;k<requested;k++) teia_reset_instance(r,o,k);
                repeat->count=(uint8_t)requested;
                for(int k=0;k<o->f;k++) repeat->active[k]=k<(int)requested;
            }
            for(int k=0;k<o->f;k++) active+=repeat->active[k]!=0;
            if(o->code==60) v[o->out]=(int32_t)active*TEIA_Q;
            for(int k=0;k<o->f;k++) if(repeat->active[k]) {
                r->repeat_offset=(uint16_t)(k*o->e); r->repeat_item=(uint16_t)k; r->repeat_gate=repeat->gates[k];
                if(o->code==60 && o->c>=0) v[o->c]=0;
                teia_run_ops(r,indices+i+1,end-i-1,left,right);
                if(o->code==60 && o->c>=0) {
                    int kill=v[o->c]>=TEIA_Q/2;
                    if(kill && !repeat->kills[k]) repeat->active[k]=0;
                    repeat->kills[k]=(uint8_t)kill;
                }
            }
            r->repeat_offset=0; r->repeat_item=0; r->repeat_gate=0;
            i=end; break;
        }
        case 57: v[o->out]=(r->repeat_item+1)*TEIA_Q; break;
        case 58: v[o->out]=o->b?teia_dsp_bound(teia_mul(v[o->out],v[o->a])):teia_dsp_bound(teia_sat((int64_t)v[o->out]+v[o->a])); break;
        case 59: case 61: break;
        case 62: v[o->out]=r->repeat_gate?TEIA_Q:0; break;
        case 63:
            if(r->block_start) r->state[o->state].level=teia_clamp(v[o->a]/TEIA_Q,0,TEIA_MAX_INSTANCES)*TEIA_Q;
            v[o->out]=r->state[o->state].level; break;
        case 54: v[o->out]=r->state[o->a].ended?TEIA_Q:0; break;
        case 55: {
            int channel=teia_clamp((int32_t)(((int64_t)v[o->b]+TEIA_Q/2)/TEIA_Q),0,16);
            teia_note_event_t event=r->event;
            v[o->out]=0;
            if(r->event_active && (!channel || channel==event.channel)) {
                if((event.on && o->a==5) || (!event.on && o->a==8)) v[o->out]=event.note*TEIA_Q;
                if((event.on && o->a==6) || (!event.on && o->a==9)) v[o->out]=note_frequency[event.note];
                if(event.on && o->a==7) v[o->out]=(int32_t)event.velocity*TEIA_Q/127;
            }
            break;
        }
        case 0: v[o->out] = teia_dsp_bound(r->values[o->a]); break;
        /* Copy is the exporter's divide-by-one specialization, so it must
         * retain the division instruction's register bound. */
        case 1: v[o->out] = teia_dsp_bound(v[o->a]); break;
        case 2: v[o->out] = teia_dsp_bound(teia_mul(v[o->a], v[o->b])); break;
        case 3: v[o->out] = teia_sine(&r->state[o->state], v[o->a]); break;
        case 20: v[o->out] = teia_range(teia_sine(&r->state[o->state], v[o->a]), v[o->b], v[o->c]); break;
        case 19: v[o->out] = teia_envelope(&r->state[o->state], v[o->a], v[o->b], v[o->c]); break;
        case 21: v[o->out]=teia_dsp_bound(teia_sat((int64_t)v[o->a]+v[o->b])); break;
        case 22: v[o->out]=teia_dsp_bound(teia_sat((int64_t)v[o->a]-v[o->b])); break;
        case 23: v[o->out]=teia_dsp_bound(teia_div(v[o->a],v[o->b])); break;
        case 24: v[o->out]=teia_sat(-(int64_t)v[o->a]); break;
        case 25: v[o->out]=teia_osc(&r->state[o->state],o,v); break;
        case 26: v[o->out]=teia_adsr(&r->state[o->state],o,v); break;
        case 27: case 29: case 30: case 31:
            v[o->out]=teia_biquad(&r->state[o->state],v[o->a],v[o->b],v[o->c],
                o->code==27 ? 1 : o->code==29 ? 2 : o->code==30 ? 3 : 8); break;
        case 28: v[o->out]=teia_noise(&r->state[o->state],v[o->a],v[o->b]); break;
        case 32: v[o->out]=teia_sat((int64_t)teia_abs(v[o->a])); break;
        case 33: v[o->out]=teia_fold(v[o->a],TEIA_Q+3*(int64_t)(v[o->b]>0?v[o->b]:0)); break;
        case 34: case 35: case 36: v[o->out]=teia_distortion(v[o->a],v[o->b],o->code); break;
        case 37: v[o->out]=teia_dc_block(&r->state[o->state],v[o->a]); break;
        case 38: v[o->out]=teia_function(o->d,v[o->a],teia_function_arity(o->d)>=2?v[o->b]:0,o->d==8?v[o->c]:0); break;
        case 39: v[o->out]=teia_accumulator(&r->state[o->state],o,v); break;
        case 40: v[o->out]=teia_random(&r->state[o->state],o->c>=0 && v[o->c]>=TEIA_Q/2,v[o->a],v[o->b]); break;
        case 41: v[o->out]=teia_dsp_bound(teia_bend(teia_clamp(v[o->a],-32*TEIA_Q,32*TEIA_Q))); break;
        case TEIA_LEGACY_DELAY_OPCODE: case TEIA_DELAY_OPCODE:
            v[o->out]=teia_delay(r,(uint32_t)o->state,v[o->a],v[o->b],v[o->c],v[o->d]); break;
        case 45: v[o->out]=teia_follower(&r->state[o->state],v[o->a],v[o->b],v[o->c]); break;
        case 46: v[o->out]=teia_map(v[o->a],v[o->b],v[o->c],v[o->d],v[o->e]); break;
        case 47: v[o->out]=teia_pow_q(v[o->a],v[o->b]); break;
        case 48: v[o->out]=teia_quantise(v[o->a],v[o->b],v[o->c]); break;
        case 49: v[o->out]=teia_tempo(&r->state[o->state],v[o->a],o->b,v[o->c]); break;
        case 50: v[o->out]=teia_sample_hold(&r->state[o->state],v[o->a],v[o->b]); break;
        case 51: v[o->out]=teia_custom_wave(&r->state[o->state],o,v,r->values); break;
        case 52: {
            int32_t channel=teia_clamp(v[o->b]/TEIA_Q,0,16);
            if(channel>1) v[o->out]=0;
            else switch(o->a) {
            case 1: v[o->out]=r->midi_frequency; break;
            case 2: v[o->out]=r->midi_velocity; break;
            case 3: v[o->out]=r->midi_gate; break;
            case 4: v[o->out]=r->midi_trigger; break;
            default: v[o->out]=r->midi_note; break;
            }
            break;
        }
        case 5: if (o->b) *right += v[o->a]; else *left += v[o->a]; break;
        case 42: v[o->out]=r->feedback[o->state]; break;
        case 43: r->feedback[o->state]=v[o->a]; break;
        }
    }
}
/* Call after copying controls into values, before rendering a buffer. No
 * stateful operation or MIDI trigger is consumed during preparation. */
static void teia_prepare_block(teia_runtime_t *r)
{
    int64_t left=0,right=0; uint32_t i;
    r->block_start=1;
    if(!r->program || !r->control_count) return;
    if(r->controls_valid) {
        for(i=0;i<r->program->value_count;i++)
            if(r->values[i]!=r->prepared_values[i]) break;
        if(i==r->program->value_count) return;
    }
    teia_run_ops(r,r->control_ops,r->control_count,&left,&right);
    for(i=0;i<r->program->value_count;i++) r->prepared_values[i]=r->values[i];
    r->controls_valid=1;
}
static void teia_sample_prepared(teia_runtime_t *r, int32_t *left, int32_t *right)
{
    int64_t l=0,rr=0;
    r->event_active=0;
    if(r->event_overflow) {
        for(unsigned k=0;k<TEIA_MAX_CONTAINERS;k++) for(unsigned n=0;n<TEIA_MAX_INSTANCES;n++) r->repeats[k].gates[n]=0;
        r->event_overflow=0;
    }
    if(r->event_gap) r->event_gap=0;
    else if(r->event_count) {
        r->event=r->events[r->event_read]; r->event_read=(r->event_read+1)%TEIA_EVENT_QUEUE;
        --r->event_count; r->event_active=r->event_gap=1;
    }
    r->midi_trigger = r->midi_trigger_pending ? TEIA_Q : 0;
    r->midi_trigger_pending = 0;
    if (!r->program) { *left = *right = 0; r->midi_trigger = 0; return; }
    teia_run_ops(r,r->audio_ops,r->audio_count,&l,&rr);
    r->block_start=0;
    *left = l > TEIA_Q ? TEIA_Q : l < -TEIA_Q ? -TEIA_Q : (int32_t)l;
    *right = rr > TEIA_Q ? TEIA_Q : rr < -TEIA_Q ? -TEIA_Q : (int32_t)rr;
    r->midi_trigger = 0;
}
/* Compatibility entry point for callers changing values between samples. */
static void teia_sample(teia_runtime_t *r, int32_t *left, int32_t *right)
{
    teia_prepare_block(r);
    teia_sample_prepared(r,left,right);
}
#endif
