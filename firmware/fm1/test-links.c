/* SPDX-License-Identifier: GPL-3.0-only */
/* Compile freely; run only when functional testing has been requested.
 * These instruction chains reproduce the shared compiler's link lowering.
 * Expected values include WASM's intermediate bounds, not just final bounds. */
#include <assert.h>
#include <stdio.h>
#include "runtime.h"

static int value(teia_program_t *p, int32_t x)
{
    int out=(int)p->registers++, index=(int)p->value_count++;
    p->values[index]=x;
    p->ops[p->count++]=(teia_op_t){.code=0,.out=out,.a=index};
    return out;
}
static int operation(teia_program_t *p, int code, int a, int b)
{
    int out=(int)p->registers++;
    p->ops[p->count++]=(teia_op_t){.code=code,.out=out,.a=a,.b=b};
    return out;
}
static void expect(teia_program_t *p, int out, int32_t expected)
{
    teia_runtime_t r={0}; int32_t left,right;
    assert(teia_load(&r,p));
    teia_sample(&r,&left,&right);
    /* Inspect the graph register before the separate audio output bound. */
    assert(r.regs[out]==expected);
}
static void set_average(void)
{
    for(int sign=-1;sign<=1;sign+=2) {
        teia_program_t p={0};
        int a=value(&p,sign*10000*TEIA_Q), b=value(&p,sign*10000*TEIA_Q);
        int count=value(&p,2*TEIA_Q);
        int sum=operation(&p,21,a,b);
        int average=operation(&p,23,sum,count);
        expect(&p,average,sign*6000*TEIA_Q);
    }
}
static void mixed_modes(void)
{
    teia_program_t p={0};
    int a=value(&p,8*TEIA_Q), b=value(&p,12*TEIA_Q);
    int half=value(&p,TEIA_Q/2), two=value(&p,2*TEIA_Q), one=value(&p,TEIA_Q);
    /* Weighted set values 8*0.5 and 12: average=8; add 2, multiply 0.5,
     * bend +1 => 10. The same sequence resolves a modulated cable strength. */
    int weighted=operation(&p,2,a,half);
    int sum=operation(&p,21,weighted,b);
    int average=operation(&p,23,sum,two);
    int added=operation(&p,21,average,two);
    int multiplied=operation(&p,2,added,half);
    int ratio=operation(&p,41,one,0);
    int result=operation(&p,2,multiplied,ratio);
    expect(&p,result,10*TEIA_Q);
    /* The resolved strength multiplies the source before entering the target. */
    int cable=operation(&p,2,half,result);
    expect(&p,cable,5*TEIA_Q);
}
static void bend_order(void)
{
    for(int reverse=0;reverse<=1;reverse++) {
        teia_program_t p={0};
        int base=value(&p,1000*TEIA_Q);
        int first=value(&p,(reverse?-4:4)*TEIA_Q);
        int second=value(&p,(reverse?4:-4)*TEIA_Q);
        int ratio=operation(&p,41,first,0);
        int bent=operation(&p,2,base,ratio);
        ratio=operation(&p,41,second,0);
        bent=operation(&p,2,bent,ratio);
        expect(&p,bent,(reverse?1000:750)*TEIA_Q);
    }
    teia_program_t p={0};
    int base=value(&p,TEIA_Q/2), exponent=value(&p,14*TEIA_Q);
    int ratio=operation(&p,41,exponent,0);
    int bent=operation(&p,2,base,ratio);
    expect(&p,bent,6000*TEIA_Q); /* Bound the ratio before multiplication. */
}
static void arithmetic_bounds(void)
{
    teia_program_t p={0};
    int hi=value(&p,INT32_MAX), lo=value(&p,INT32_MIN);
    int half=value(&p,TEIA_Q/2);
    expect(&p,hi,TEIA_DSP_LIMIT);
    expect(&p,lo,-TEIA_DSP_LIMIT);
    int difference=operation(&p,22,lo,hi);
    expect(&p,difference,-TEIA_DSP_LIMIT);
    int quotient=operation(&p,23,lo,half);
    expect(&p,quotient,-TEIA_DSP_LIMIT);
    /* MIDI frequency can enter directly without a Value instruction. Verify
     * the exporter's optimized divide by one has the same bound as Div. */
    int channel=value(&p,0), frequency=operation(&p,52,1,channel);
    int copy=operation(&p,1,frequency,0);
    int one=value(&p,TEIA_Q), divided=operation(&p,23,frequency,one);
    teia_runtime_t r={0}; int32_t left,right;
    assert(teia_load(&r,&p)); r.midi_frequency=20000*TEIA_Q;
    teia_sample(&r,&left,&right);
    assert(r.regs[copy]==TEIA_DSP_LIMIT && r.regs[copy]==r.regs[divided]);
}
int main(void)
{
    set_average(); mixed_modes(); bend_order(); arithmetic_bounds();
    puts("PASS: link averaging, mixed modes, strength modulation, bend order and graph arithmetic bounds");
}
