/* Static compilation is allowed; execute only with explicit functional-test permission.
 * cc -std=c11 -I<export directory> -Ifirmware/fm1 test-events-repeat.c -o <binary>
 */
#include <assert.h>
#include <string.h>
#include "runtime.h"
static teia_runtime_t runtime;
static teia_program_t program;
static void sample(void) { int32_t l, r; teia_sample_prepared(&runtime,&l,&r); }
static void events(void)
{
    program=(teia_program_t){.count=4,.registers=4,.value_count=1};
    program.ops[0]=(teia_op_t){.code=0,.out=0,.a=0};
    program.ops[1]=(teia_op_t){.code=55,.out=1,.a=5,.b=0};
    program.ops[2]=(teia_op_t){.code=55,.out=2,.a=7,.b=0};
    program.ops[3]=(teia_op_t){.code=55,.out=3,.a=8,.b=0};
    assert(teia_load(&runtime,&program)); teia_prepare_block(&runtime);
    assert(teia_queue_note(&runtime,16,60,64,1));
    assert(teia_queue_note(&runtime,16,64,127,1));
    assert(teia_queue_note(&runtime,16,60,0,0));
    sample(); assert(runtime.regs[1]==60*TEIA_Q && runtime.regs[2]==64*TEIA_Q/127);
    sample(); assert(!runtime.regs[1] && !runtime.regs[2]);
    sample(); assert(runtime.regs[1]==64*TEIA_Q);
    sample(); sample(); assert(runtime.regs[3]==60*TEIA_Q && !runtime.regs[1]);
    runtime.values[0]=TEIA_Q; teia_prepare_block(&runtime);
    assert(teia_queue_note(&runtime,16,65,127,1)); sample(); sample(); assert(!runtime.regs[1]);
}
static void completion(void)
{
    teia_state_t state={0};
    teia_op_t op={.a=0,.b=1,.c=2,.d=3,.e=4,.f=5,.g=6,.h=7};
    int32_t values[8]={TEIA_Q,0,0,TEIA_Q,0,0,0,0};
    teia_adsr(&state,&op,values); assert(!state.ended);
    for(int i=0;i<48;i++) teia_adsr(&state,&op,values);
    values[0]=0; teia_adsr(&state,&op,values); assert(state.ended && !state.stage);
    teia_adsr(&state,&op,values); assert(!state.ended);
    values[0]=TEIA_Q; teia_adsr(&state,&op,values); assert(!state.ended && state.stage);
}
static void repeat(void)
{
    /* Two live voices, independent sample holds, matching-tag release and kill. */
    program=(teia_program_t){.count=10,.registers=8,.value_count=4};
    for(int i=0;i<4;i++) program.ops[i]=(teia_op_t){.code=0,.out=i,.a=i};
    program.ops[4]=(teia_op_t){.code=60,.out=4,.a=0,.b=9,.c=3,.state=0,.d=1,.e=1,.f=2,.g=0};
    program.ops[5]=(teia_op_t){.code=62,.out=5};
    program.ops[6]=(teia_op_t){.code=50,.out=6,.a=2,.b=5,.state=0};
    program.ops[7]=(teia_op_t){.code=58,.out=7,.a=6};
    program.ops[8]=(teia_op_t){.code=1,.out=3,.a=1};
    program.ops[9]=(teia_op_t){.code=61};
    assert(teia_load(&runtime,&program)); teia_prepare_block(&runtime);
    runtime.values[0]=60*TEIA_Q; runtime.values[2]=TEIA_Q; sample(); assert(runtime.regs[7]==TEIA_Q);
    runtime.values[0]=0; sample();
    runtime.values[0]=64*TEIA_Q; runtime.values[2]=2*TEIA_Q; sample(); assert(runtime.regs[7]==3*TEIA_Q);
    sample(); assert(runtime.regs[4]==2*TEIA_Q); /* held trigger */
    runtime.values[0]=0; sample(); runtime.values[0]=67*TEIA_Q; sample(); assert(runtime.regs[4]==2*TEIA_Q);
    runtime.values[0]=0; runtime.values[1]=60*TEIA_Q; sample(); assert(!runtime.repeats[0].gates[0] && runtime.repeats[0].gates[1]);
    /* Kill was high in each instance, so both have been removed after rendering. */
    sample(); assert(runtime.regs[4]==0);
    program.ops[4].b=8; assert(!teia_validate(&program));
    program.ops[4].b=9; program.ops[4].e=TEIA_MAX_STATES; assert(!teia_validate(&program));
}
static void spread(void)
{
    program=(teia_program_t){.count=6,.registers=5,.value_count=1,.values={8*TEIA_Q}};
    program.ops[0]=(teia_op_t){.code=0,.out=0,.a=0};
    program.ops[1]=(teia_op_t){.code=63,.out=1,.a=0,.state=0};
    program.ops[2]=(teia_op_t){.code=56,.a=1,.b=5,.c=-1,.state=1,.d=-1,.e=0,.f=2,.g=0};
    program.ops[3]=(teia_op_t){.code=57,.out=2};
    program.ops[4]=(teia_op_t){.code=58,.out=3,.a=2};
    program.ops[5]=(teia_op_t){.code=59};
    assert(teia_load(&runtime,&program)); teia_prepare_block(&runtime); sample();
    assert(runtime.regs[1]==2*TEIA_Q && runtime.regs[3]==3*TEIA_Q);
    runtime.values[0]=0; sample(); assert(runtime.regs[1]==2*TEIA_Q);
    teia_prepare_block(&runtime); sample(); assert(!runtime.regs[1] && !runtime.regs[3]);
}
int main(void) { events(); completion(); repeat(); spread(); return 0; }
