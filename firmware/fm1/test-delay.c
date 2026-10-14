/* Offline regression assertions. Compile without running for static validation;
 * execute only when functional testing has been explicitly authorized. */
#include <assert.h>
#include "runtime.h"

static teia_runtime_t runtime;
static teia_program_t program;

static void reset(void)
{
    program = (teia_program_t){.count=3, .registers=4, .value_count=1};
    program.ops[0] = (teia_op_t){.code=0, .out=0, .a=0};
    program.ops[1] = (teia_op_t){.code=TEIA_DELAY_OPCODE, .out=1, .state=7};
    program.ops[2] = (teia_op_t){.code=TEIA_DELAY_OPCODE, .out=2, .state=23};
    assert(teia_load(&runtime, &program));
    assert(runtime.delay_slot[7] == 0 && runtime.delay_slot[23] == 1);
}

static void capacity_and_isolation(void)
{
    reset();
    for (uint32_t n=0; n<=TEIA_FS*2; ++n) {
        /* Exercise exact one second, half a second, and ring wrap. */
        int32_t a=teia_delay(&runtime, 7, n==0 ? TEIA_Q : 0, TEIA_Q, 0, TEIA_Q);
        int32_t b=teia_delay(&runtime, 23, n==0 ? -TEIA_Q/2 : 0, TEIA_Q/2, 0, TEIA_Q);
        assert(a == (n==TEIA_FS ? TEIA_Q : 0));
        assert(b == (n==TEIA_FS/2 ? -TEIA_Q/2 : 0));
    }
    /* Reload invalidates old contents, including the second slot, without
     * clearing the large buffers from inside the audio interrupt. */
    for (unsigned slot=0; slot<TEIA_MAX_DELAYS; ++slot)
        for (unsigned i=0; i<TEIA_MAX_DELAY_SAMPLES; ++i) runtime.delay[slot][i]=32767;
    reset();
    for (uint32_t n=0; n<TEIA_FS; ++n) {
        assert(teia_delay(&runtime, 7, 0, TEIA_Q, 0, TEIA_Q) == 0);
        assert(teia_delay(&runtime, 23, 0, TEIA_Q/2, 0, TEIA_Q) == 0);
    }
}

static void fractional_and_zero(void)
{
    reset();
    /* Two Q16 seconds units = 1.3458251953125 samples. An impulse splits
     * between the surrounding integer taps, with unity total gain. */
    assert(teia_delay(&runtime, 7, TEIA_Q, 2, 0, TEIA_Q) == 0);
    int32_t first=teia_delay(&runtime, 7, 0, 2, 0, TEIA_Q);
    int32_t second=teia_delay(&runtime, 7, 0, 2, 0, TEIA_Q);
    assert(first == 2*TEIA_Q-2*(int32_t)TEIA_FS);
    assert(first+second == TEIA_Q);
    assert(teia_delay(&runtime, 7, 0, 2, 0, TEIA_Q) == 0);
    /* Zero bypass preserves low bits of the input even at full wet/feedback. */
    assert(teia_delay(&runtime, 23, 12345, 0, 2*TEIA_Q, TEIA_Q) == 12345);
    reset();
    /* Sub-sample read interpolates current input and history. */
    assert(teia_delay(&runtime, 7, TEIA_Q, 1, 0, TEIA_Q) == TEIA_Q-(int32_t)TEIA_FS);
    assert(teia_delay(&runtime, 7, 0, 1, 0, TEIA_Q) == TEIA_FS);
}

static void smoothing_and_bounds(void)
{
    reset();
    teia_delay(&runtime, 7, 0, 0, 0, 0);
    uint32_t maximum=TEIA_FS*(uint32_t)TEIA_Q, previous=0;
    for (unsigned i=0; i<8192; ++i) {
        teia_delay(&runtime, 7, 0, INT32_MAX, 0, 0);
        uint32_t current=runtime.delay_state[0].time;
        assert(current>=previous && current<=maximum);
        if (!i) assert(current>0 && current<maximum/100);
        previous=current;
    }
    assert(previous==maximum);
    for (unsigned i=0; i<8192; ++i) {
        teia_delay(&runtime, 7, 0, INT32_MIN, 0, 0);
        uint32_t current=runtime.delay_state[0].time;
        assert(current<=previous);
        previous=current;
    }
    assert(previous==0);
    assert(teia_delay_pack(8*TEIA_Q)==32767);
    assert(teia_delay_pack(-8*TEIA_Q)==-32768);
    assert(teia_delay_pack(INT32_MAX)==32767);
    assert(teia_delay_pack(INT32_MIN)==-32768);
    assert(teia_delay_pack(8)==1 && teia_delay_pack(-8)==-1);
    /* Live time/feedback/mix modulation remains bounded, including feedback
     * above unity and a bipolar input exceeding the storage headroom. */
    for (unsigned i=0; i<10000; ++i) {
        int32_t out=teia_delay(&runtime, 7, i%2 ? INT32_MAX : INT32_MIN,
            i%97, 2*TEIA_Q, TEIA_Q);
        assert(out>=-8*TEIA_Q && out<=8*TEIA_Q);
        assert(runtime.delay_state[0].time<=maximum);
    }
}

static void validation(void)
{
    reset();
    program.count=4;
    program.ops[3]=(teia_op_t){.code=TEIA_DELAY_OPCODE, .out=3, .state=12};
    assert(!teia_validate(&program));
    program.count=3;
    program.ops[2].state=7;
    assert(!teia_validate(&program));
    program.ops[2].state=23;
    program.ops[1].code=TEIA_LEGACY_DELAY_OPCODE;
    assert(teia_load(&runtime, &program));
    assert(runtime.delay_slot[7]==0 && runtime.delay_slot[23]==1);
}

int main(void)
{
    capacity_and_isolation();
    fractional_and_zero();
    smoothing_and_bounds();
    validation();
    return 0;
}
