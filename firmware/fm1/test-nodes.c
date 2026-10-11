/* SPDX-License-Identifier: GPL-3.0-only */
/* Offline DSP checks. Compile/run explicitly; never touches the FM-1. */
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include "runtime.h"
static void arithmetic(void)
{
    assert(teia_sat((int64_t)INT32_MAX+1)==INT32_MAX);
    assert(teia_sat((int64_t)INT32_MIN-1)==INT32_MIN);
    assert(teia_div(TEIA_Q,2*TEIA_Q)==TEIA_Q/2);
    assert(teia_div(-TEIA_Q,2*TEIA_Q)==-TEIA_Q/2);
    assert(teia_div(INT32_MIN,-TEIA_Q)==INT32_MAX);
    assert(teia_div(TEIA_Q,0)==0);
    assert(teia_fraction(1,2,16)==32768);
    /* Neutral link paths, including the signed extremes and odd negative
     * numerators whose averages must truncate toward zero, not floor. */
    assert(teia_mul(INT32_MIN,0)==0);
    assert(teia_mul(INT32_MIN,TEIA_Q)==INT32_MIN);
    assert(teia_mul(TEIA_Q,INT32_MAX)==INT32_MAX);
    assert(teia_div(-3,2*TEIA_Q)==-1);
    assert(teia_div(3,-2*TEIA_Q)==-1);
    assert(teia_div(INT32_MIN,2*TEIA_Q)==INT32_MIN/2);
    assert(teia_div(INT32_MIN,TEIA_Q)==INT32_MIN);
}
static void power(void)
{
    const int32_t identity_inputs[]={INT32_MIN,-10000*TEIA_Q,-TEIA_Q,-1,0,1,TEIA_Q/3,TEIA_Q,INT32_MAX};
    for(unsigned i=0;i<sizeof identity_inputs/sizeof *identity_inputs;i++)
        assert(teia_pow_q(identity_inputs[i],TEIA_Q)==identity_inputs[i]);
    /* Pow follows the browser's sign-preserving semantics at fractional
     * exponents, so bipolar audio stays bipolar instead of half-wave clipping. */
    assert(teia_pow_q(TEIA_Q/4,TEIA_Q/2)>TEIA_Q/2-2);
    assert(teia_pow_q(TEIA_Q/4,TEIA_Q/2)<TEIA_Q/2+2);
    assert(teia_pow_q(-TEIA_Q/4,TEIA_Q/2)<-TEIA_Q/2+2);
    assert(teia_pow_q(-TEIA_Q/4,TEIA_Q/2)>-TEIA_Q/2-2);
    assert(teia_pow_q(-TEIA_Q/4,TEIA_Q/4)<-46300);
    assert(teia_pow_q(-TEIA_Q/4,TEIA_Q/4)>-46400);
    assert(teia_pow_q(-TEIA_Q/4,-TEIA_Q/2)<-2*TEIA_Q+8);
    assert(teia_pow_q(-TEIA_Q/4,-TEIA_Q/2)>-2*TEIA_Q-8);
    assert(fabs((double)teia_pow_q(-TEIA_Q/4,99*TEIA_Q/100)+pow(0.25,0.99)*TEIA_Q)<32);
}
static void bend(void)
{
    assert(teia_bend(0)==TEIA_Q);
    assert(teia_bend(TEIA_Q)==2*TEIA_Q);
    assert(teia_bend(-TEIA_Q)==TEIA_Q/2);
    assert(teia_bend(14*TEIA_Q)==1073741824);
    assert(teia_bend(15*TEIA_Q)==INT32_MAX);
    assert(teia_bend(INT32_MAX)==INT32_MAX);
    assert(teia_bend(INT32_MIN)==0);
    assert(teia_bend(-17*TEIA_Q)==1);
    assert(teia_bend(-17*TEIA_Q-1)==0);
    int32_t previous=0;
    for(int32_t x=-17*TEIA_Q; x<15*TEIA_Q; x+=17) {
        double expected=pow(2.0,(double)x/TEIA_Q)*TEIA_Q;
        int32_t actual=teia_bend(x);
        assert(actual>=previous); previous=actual;
        assert(fabs(actual-expected)<=expected*0.000001+0.501);
    }
    teia_program_t p={0}; teia_runtime_t r={0}; int32_t left,right;
    p.count=3; p.registers=2; p.value_count=1; p.values[0]=-TEIA_Q;
    p.ops[0]=(teia_op_t){.code=0,.out=0,.a=0};
    p.ops[1]=(teia_op_t){.code=41,.out=1,.a=0};
    p.ops[2]=(teia_op_t){.code=5,.a=1,.b=0};
    assert(teia_load(&r,&p)); teia_sample(&r,&left,&right);
    assert(left==TEIA_Q/2 && right==0);
    p.ops[1].a=1; assert(!teia_validate(&p)); /* unassigned source */
    p.ops[1].a=2; assert(!teia_validate(&p)); /* out of bounds */
    p.ops[1].a=0; p.ops[1].out=2; assert(!teia_validate(&p));
}
static void oscillators(void)
{
    assert(teia_wave(0,1,0)==0);
    assert(teia_wave(0x40000000u,1,0)==TEIA_Q);
    assert(teia_wave(0xc0000000u,1,0)==-TEIA_Q);
    assert(teia_wave(0,2,0)==-TEIA_Q);
    assert(teia_wave(0,3,0)==TEIA_Q);
    assert(teia_wave(0,4,0)==-TEIA_Q);
    assert(teia_wave(UINT32_MAX,4,TEIA_Q)==TEIA_Q);
    teia_state_t s={0}; int32_t v[]={0,-TEIA_Q,TEIA_Q,TEIA_Q/4,0};
    teia_op_t o={.a=0,.b=1,.c=2,.d=3,.e=4,.f=-1,.g=0};
    assert(teia_osc(&s,&o,v)>TEIA_Q-10);
    v[3]=-TEIA_Q/4; assert(teia_osc(&s,&o,v)<-TEIA_Q+10);
    s.phase=0x40000000u; v[3]=0; v[4]=TEIA_Q;
    assert(teia_osc(&s,&o,v)>TEIA_Q-10 && s.phase==0); /* reset starts at the prior sample */
    s.phase=0x40000000u; assert(teia_osc(&s,&o,v)>TEIA_Q-10); /* held reset is not another edge */
    s.phase=1234567; int32_t first=teia_noise(&s,0,TEIA_Q); int changed=0;
    for(int i=0;i<1000;i++) { int32_t n=teia_noise(&s,0,TEIA_Q); assert(n>=0 && n<=TEIA_Q); changed |= n!=first; }
    assert(changed);
}
static void envelope(void)
{
    const uint32_t durations[]={0,1,2,45,441,22050,60*TEIA_FS};
    teia_state_t progress={0};
    for(unsigned d=0;d<sizeof durations/sizeof *durations;d++) {
        for(unsigned i=0;i<30000;i++) {
            progress.elapsed=i;
            assert(teia_progress_cached(&progress,durations[d])==teia_progress(i,durations[d]));
        }
        /* Endpoints, repeated elapsed values, backwards jumps, and a changed
         * duration must never reuse an inapplicable incremental result. */
        const uint32_t jumps[]={durations[d],1,0,7,7,6,1000};
        for(unsigned j=0;j<sizeof jumps/sizeof *jumps;j++) {
            progress.elapsed=jumps[j];
            assert(teia_progress_cached(&progress,durations[d])==teia_progress(jumps[j],durations[d]));
        }
    }
    teia_state_t s={0}; int32_t v[]={TEIA_Q,0,0,TEIA_Q/2,0,0,0,0};
    teia_op_t o={.a=0,.b=1,.c=2,.d=3,.e=4,.f=5,.g=6,.h=7};
    for(int i=0;i<45;i++) teia_adsr(&s,&o,v);
    assert(s.level==TEIA_Q); teia_adsr(&s,&o,v); assert(s.level==TEIA_Q/2 && s.stage==3);
    v[0]=0; assert(teia_adsr(&s,&o,v)==0 && s.stage==0);
    v[5]=TEIA_Q; v[6]=TEIA_Q/100; v[7]=TEIA_Q/100;
    teia_adsr(&s,&o,v); assert(s.stage==5 && s.level==0);
    v[5]=0;
    for(int i=0;i<2000;i++) { int32_t n=teia_adsr(&s,&o,v); assert(n>=0 && n<=TEIA_Q); }
    assert(s.stage==0 && s.level==0); /* delay, attack, decay, timed hold, release */
    v[0]=TEIA_Q; v[6]=0; v[1]=60*TEIA_Q;
    for(unsigned i=0;i<60*TEIA_FS;i++) teia_adsr(&s,&o,v);
    assert(s.level==TEIA_Q);
}
static void midi_trigger_is_not_gate(void)
{
    /* MIDI trigger -> Envelope trigger, with no Envelope gate connection. */
    teia_program_t p={0}; teia_runtime_t r={0}; int32_t left,right;
    p.count=9; p.registers=8; p.value_count=7;
    p.values[0]=0; p.values[1]=0; p.values[2]=0; p.values[3]=TEIA_Q/2;
    p.values[4]=0; p.values[5]=0; p.values[6]=0;
    p.ops[0]=(teia_op_t){.code=0,.out=0,.a=0}; /* MIDI channel */
    p.ops[1]=(teia_op_t){.code=52,.out=1,.a=4,.b=0}; /* MIDI trigger */
    p.ops[2]=(teia_op_t){.code=0,.out=2,.a=1}; /* gate is disconnected */
    p.ops[3]=(teia_op_t){.code=0,.out=3,.a=2}; /* attack */
    p.ops[4]=(teia_op_t){.code=0,.out=4,.a=3}; /* decay */
    p.ops[5]=(teia_op_t){.code=0,.out=5,.a=4}; /* sustain */
    p.ops[6]=(teia_op_t){.code=0,.out=6,.a=5}; /* release */
    p.ops[7]=(teia_op_t){.code=0,.out=7,.a=6}; /* delay / gate length */
    p.ops[8]=(teia_op_t){.code=26,.out=0,.a=2,.b=3,.c=4,.d=5,.e=6,.f=1,.g=7,.h=7,.state=0};
    assert(teia_load(&r,&p));
    r.midi_gate=TEIA_Q; r.midi_trigger_pending=1;
    teia_sample(&r,&left,&right);
    assert(r.midi_trigger==0 && r.state[0].trigger==1);
    teia_sample(&r,&left,&right);
    assert(r.state[0].trigger==0);
    for(unsigned i=0;i<50;i++) {
        teia_sample(&r,&left,&right);
        assert(r.state[0].stage!=3); /* sustain is reachable only through gate */
    }
}
static double filter_gain(double hz, int mode)
{
    teia_state_t s={0}; double input=0,output=0;
    for(unsigned i=0;i<TEIA_FS;i++) {
        double x=0.1*sin(6.283185307179586*hz*i/TEIA_FS);
        double y=(double)teia_biquad(&s,(int32_t)(x*TEIA_Q),1000*TEIA_Q,(int32_t)(0.707*TEIA_Q),mode)/TEIA_Q;
        if(i>TEIA_FS/2) { input+=x*x; output+=y*y; }
    }
    return sqrt(output/input);
}
static void filters(void)
{
    assert(filter_gain(100,1)>0.95); assert(filter_gain(1000,1)>0.65 && filter_gain(1000,1)<0.76);
    assert(filter_gain(10000,1)<0.02);
    assert(filter_gain(100,2)<0.02 && filter_gain(10000,2)>0.95);
    assert(filter_gain(1000,2)>0.65 && filter_gain(1000,2)<0.76);
    assert(filter_gain(1000,3)>0.98 && filter_gain(1000,3)<1.02);
    assert(filter_gain(100,3)<0.2 && filter_gain(10000,3)<0.2);
    for(int hz=100;hz<=10000;hz*=10)
        assert(filter_gain(hz,8)>0.98 && filter_gain(hz,8)<1.02);
    int32_t cuts[]={20*TEIA_Q,1000*TEIA_Q,19845*TEIA_Q};
    int modes[]={1,2,3,8};
    for(unsigned m=0;m<4;m++) for(unsigned c=0;c<3;c++) for(int q=0;q<2;q++) {
        teia_state_t s={0};
        for(unsigned i=0;i<TEIA_FS;i++) {
            int32_t y=teia_biquad(&s,i==0?TEIA_Q:0,cuts[c],q?16*TEIA_Q:TEIA_Q/4,modes[m]);
            assert(y>-32*TEIA_Q && y<32*TEIA_Q);
        }
    }
}
/* These checks are compiled with the firmware sources; execute only when
 * host DSP testing is explicitly requested. */
static void shaping(void)
{
    assert(teia_distortion(TEIA_Q/2,4*TEIA_Q,34)==TEIA_Q);
    assert(teia_distortion(-TEIA_Q/2,4*TEIA_Q,34)==-TEIA_Q);
    assert(teia_distortion(TEIA_Q,TEIA_Q,35)==TEIA_Q/2);
    assert(teia_distortion(-TEIA_Q,TEIA_Q,35)==-TEIA_Q/2);
    assert(teia_distortion(INT32_MIN,INT32_MAX,34)==-TEIA_Q);
    assert(teia_distortion(TEIA_Q,0,34)==6554);
    assert(teia_distortion(TEIA_Q,INT32_MAX,35)==teia_div(32*TEIA_Q,33*TEIA_Q));
    assert(teia_fold(TEIA_Q/2,TEIA_Q)==TEIA_Q/2);
    assert(teia_fold(TEIA_Q,2*TEIA_Q)==0);
    assert(teia_fold(TEIA_Q,3*TEIA_Q)==-TEIA_Q);
    assert(teia_fold(-TEIA_Q,3*TEIA_Q)==TEIA_Q);
    assert(teia_fold(TEIA_Q,5*TEIA_Q)==TEIA_Q);
    assert(teia_distortion(TEIA_Q,3*TEIA_Q,36)==-TEIA_Q);
    int32_t inputs[]={INT32_MIN,INT32_MAX,-TEIA_Q,0,TEIA_Q};
    for(unsigned i=0;i<5;i++) {
        int32_t y=teia_fold(inputs[i],TEIA_Q+3*(int64_t)INT32_MAX);
        assert(y>=-TEIA_Q && y<=TEIA_Q);
    }
    teia_state_t dc={0};
    assert(teia_dc_block(&dc,TEIA_Q)==TEIA_Q);
    int32_t last=TEIA_Q;
    for(unsigned i=0;i<TEIA_FS;i++) {
        int32_t y=teia_dc_block(&dc,TEIA_Q);
        assert(y>=0 && y<=last); last=y;
    }
    assert(last<TEIA_Q/1000);
    dc=(teia_state_t){0};
    for(unsigned i=0;i<1000;i++) {
        int32_t y=teia_dc_block(&dc,i%2?INT32_MIN:INT32_MAX);
        assert(y>=-4*TEIA_Q && y<=4*TEIA_Q);
    }
}
static void controls(void)
{
    assert(teia_function(8,2*TEIA_Q,TEIA_Q,-TEIA_Q)==TEIA_Q);
    assert(teia_function(6,-TEIA_Q,TEIA_Q,0)==-TEIA_Q);
    assert(teia_function(7,-TEIA_Q,TEIA_Q,0)==TEIA_Q);
    assert(teia_function(13,-TEIA_Q/2,0,0)==-TEIA_Q);
    assert(teia_function(14,-TEIA_Q/2,0,0)==0);
    assert(teia_function(15,-TEIA_Q/2,0,0)==-TEIA_Q);
    assert(teia_function(15,TEIA_Q/2,0,0)==TEIA_Q);
    assert(teia_function(14,INT32_MAX,0,0)==INT32_MAX);
    assert(teia_function(13,INT32_MIN,0,0)==INT32_MIN);
    assert(teia_function(17,-TEIA_Q/4,0,0)==3*TEIA_Q/4);
    assert(teia_function(19,-1,0,0)==TEIA_Q);
    assert(teia_function(23,1,1,0)==TEIA_Q);
    assert(teia_function(25,-1,1,0)==TEIA_Q);
    assert(teia_function(26,0,0,0)==0);
    assert(teia_function(27,0,0,0)==TEIA_Q);
    teia_state_t s={0}; int32_t v[]={0,0,2*TEIA_Q,TEIA_Q,0};
    teia_op_t o={.a=0,.b=1,.c=2,.d=3,.e=4};
    assert(teia_accumulator(&s,&o,v)==0);
    v[0]=TEIA_Q; assert(teia_accumulator(&s,&o,v)==TEIA_Q);
    assert(teia_accumulator(&s,&o,v)==TEIA_Q); /* held trigger */
    v[0]=0; teia_accumulator(&s,&o,v); v[0]=TEIA_Q;
    assert(teia_accumulator(&s,&o,v)==2*TEIA_Q);
    v[0]=0; teia_accumulator(&s,&o,v); v[0]=TEIA_Q;
    assert(teia_accumulator(&s,&o,v)==0); /* wrap, discarding overshoot */
    v[4]=TEIA_Q; o.f=1; assert(teia_accumulator(&s,&o,v)==0); /* reset wins */
    assert(teia_accumulator(&s,&o,v)==TEIA_Q); /* held reset is not another edge */
    v[4]=0; v[1]=2*TEIA_Q; v[2]=0; v[3]=-2*TEIA_Q;
    assert(teia_accumulator(&s,&o,v)==2*TEIA_Q); /* reversed bounds, negative step */
    s=(teia_state_t){.phase=1234567};
    int32_t held=teia_random(&s,1,-TEIA_Q,TEIA_Q); uint32_t seed=s.phase;
    assert(teia_random(&s,1,-TEIA_Q,TEIA_Q)==held && s.phase==seed);
    assert(teia_random(&s,0,TEIA_Q,TEIA_Q)==TEIA_Q && s.phase==seed);
    teia_random(&s,1,-TEIA_Q,TEIA_Q); assert(s.phase!=seed);
}
static void validation(void)
{
    teia_program_t p={.count=3,.registers=2,.value_count=1,
      .ops={{.code=0,.out=0,.a=0},{.code=25,.out=1,.a=0,.b=0,.c=0,.state=0,.d=-1,.e=-1,.f=0,.g=4},{.code=5,.a=1}}};
    teia_runtime_t r={0}; int32_t l, rr;
    assert(teia_load(&r,&p)); teia_sample(&r,&l,&rr);
    assert(teia_validate(&p));
    p.ops[1].f=2; assert(!teia_validate(&p)); p.ops[1].f=0;
    p.ops[1].e=-2; assert(!teia_validate(&p)); p.ops[1].e=-1;
    p.ops[1].state=TEIA_MAX_STATES; assert(!teia_validate(&p));
    for(int code=29;code<=31;code++) {
        p.ops[1]=(teia_op_t){.code=code,.out=1,.a=0,.b=0,.c=0,.state=0};
        assert(teia_load(&r,&p)); teia_sample(&r,&l,&rr);
        p.ops[1].c=2; assert(!teia_validate(&p)); p.ops[1].c=0;
        p.ops[1].state=TEIA_MAX_STATES; assert(!teia_validate(&p));
    }
    p.count=5; p.registers=3; p.value_count=1; p.values[0]=TEIA_Q/2;
    p.ops[0]=(teia_op_t){.code=42,.out=0,.state=0};
    p.ops[1]=(teia_op_t){.code=0,.out=1,.a=0};
    p.ops[2]=(teia_op_t){.code=21,.out=2,.a=0,.b=1};
    p.ops[3]=(teia_op_t){.code=43,.out=0,.a=2,.state=0};
    p.ops[4]=(teia_op_t){.code=5,.a=0,.b=0};
    assert(teia_load(&r,&p)); teia_sample(&r,&l,&rr); assert(l==0);
    teia_sample(&r,&l,&rr); assert(l==TEIA_Q/2);
    p.ops[3].state=1; assert(!teia_validate(&p)); p.ops[3].state=0;
    p.ops[0].state=TEIA_MAX_STATES; assert(!teia_validate(&p)); p.ops[0].state=0;
    p.count=3; p.registers=2; p.value_count=1;
    p.ops[0]=(teia_op_t){.code=0,.out=0,.a=0};
    p.ops[2]=(teia_op_t){.code=5,.a=1};
    for(int code=32;code<=37;code++) {
        p.values[0]=INT32_MIN;
        p.ops[1]=(teia_op_t){.code=code,.out=1,.a=0,.b=0,.state=0};
        assert(teia_load(&r,&p)); teia_sample(&r,&l,&rr);
        if(code==32) assert(r.regs[1]==TEIA_DSP_LIMIT); /* Value load bounds INT32_MIN like WASM. */
        p.ops[1].a=2; assert(!teia_validate(&p)); p.ops[1].a=0;
        if(code>=33 && code<=36) { p.ops[1].b=2; assert(!teia_validate(&p)); p.ops[1].b=0; }
        if(code==37) { p.ops[1].state=TEIA_MAX_STATES; assert(!teia_validate(&p)); }
    }
    p.ops[1]=(teia_op_t){.code=38,.out=1,.a=0,.b=0,.c=0,.d=8};
    assert(teia_validate(&p)); p.ops[1].c=2; assert(!teia_validate(&p));
    p.ops[1].d=9; assert(!teia_validate(&p));
    p.ops[1]=(teia_op_t){.code=39,.out=1,.a=0,.b=0,.c=0,.d=0,.e=0};
    assert(teia_load(&r,&p)); teia_sample(&r,&l,&rr);
    p.ops[1].f=2; assert(!teia_validate(&p)); p.ops[1].f=0;
    p.ops[1].e=2; assert(!teia_validate(&p));
    p.ops[1]=(teia_op_t){.code=40,.out=1,.a=0,.b=0,.c=-1};
    assert(teia_load(&r,&p)); teia_sample(&r,&l,&rr);
    p.ops[1].c=-2; assert(!teia_validate(&p)); p.ops[1].c=2; assert(!teia_validate(&p));
    p.ops[1].c=-1; p.ops[1].state=TEIA_MAX_STATES; assert(!teia_validate(&p));

}
int main(void)
{
    arithmetic(); power(); bend(); oscillators(); envelope(); midi_trigger_is_not_gate(); filters(); shaping(); controls(); validation();
    puts("PASS: arithmetic/power bounds, waveforms, modulation/reset, noise, ADSR, low/high/band/all-pass response, shaping/DC, controls, validation");
}
