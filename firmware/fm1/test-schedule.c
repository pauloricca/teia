/* SPDX-License-Identifier: GPL-3.0-only */
/* Offline comparison of buffer preparation with original instruction order.
 * Run explicitly with one or more exported .tgp packages. No device access. */
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "upload.h"

static void compare_package(const char *path)
{
    uint8_t bytes[TEIA_PACKAGE_MAX];
    teia_patch_t patch={0}; teia_runtime_t scalar={0},prepared={0};
    FILE *file=fopen(path,"rb"); assert(file);
    size_t size=fread(bytes,1,sizeof bytes,file); fclose(file);
    assert(teia_decode(&patch,bytes,(uint32_t)size));
    assert(teia_load(&scalar,&patch.program)); assert(teia_load(&prepared,&patch.program));
    /* Force the oracle to execute every instruction in the original order,
     * including all loads and control calculations, on every sample. */
    scalar.control_count=0; scalar.audio_count=(uint16_t)patch.program.count;
    for(unsigned i=0;i<patch.program.count;i++) scalar.audio_ops[i]=(uint16_t)i;
    for(unsigned block=0;block<700;block++) {
        if(block%37==0) for(unsigned k=0;k<patch.knob_count;k++) {
            teia_knob_t *knob=&patch.knobs[k];
            int32_t value=(block/37)%3==0 ? knob->min : (block/37)%3==1 ? knob->max :
                (int32_t)(((int64_t)knob->min+knob->max)/2);
            scalar.values[knob->value]=prepared.values[knob->value]=value;
        }
        scalar.midi_note=prepared.midi_note=60*TEIA_Q;
        scalar.midi_frequency=prepared.midi_frequency=220*TEIA_Q;
        scalar.midi_gate=prepared.midi_gate=block%51<25?TEIA_Q:0;
        scalar.midi_trigger_pending=prepared.midi_trigger_pending=block%51==0;
        teia_prepare_block(&prepared);
        /* Cached preparation must not consume a trigger or advance DSP. */
        teia_prepare_block(&prepared);
        assert(scalar.midi_trigger_pending==prepared.midi_trigger_pending);
        for(unsigned frame=0;frame<128;frame++) {
            int32_t al,ar,bl,br;
            teia_sample(&scalar,&al,&ar);
            teia_sample_prepared(&prepared,&bl,&br);
            assert(al==bl && ar==br);
            assert(!memcmp(scalar.regs,prepared.regs,sizeof scalar.regs));
            assert(!memcmp(scalar.state,prepared.state,sizeof scalar.state));
            assert(!memcmp(scalar.feedback,prepared.feedback,sizeof scalar.feedback));
        }
    }
    printf("PASS: %s (%u control, %u audio; exact samples/registers/state)\n",patch.name,prepared.control_count,prepared.audio_count);
}
static void reassigned_registers(void)
{
    teia_program_t p={0}; teia_runtime_t r={0}; int32_t l,right;
    p.count=4; p.registers=2; p.value_count=2; p.values[0]=TEIA_Q; p.values[1]=TEIA_Q/2;
    p.ops[0]=(teia_op_t){.code=0,.out=0,.a=0};
    p.ops[1]=(teia_op_t){.code=1,.out=1,.a=0};
    p.ops[2]=(teia_op_t){.code=0,.out=0,.a=1};
    p.ops[3]=(teia_op_t){.code=5,.a=1};
    assert(teia_load(&r,&p)); assert(r.control_count==0 && r.audio_count==4);
    teia_prepare_block(&r); teia_sample_prepared(&r,&l,&right);
    assert(l==TEIA_Q && right==0);
}
int main(int argc,char **argv)
{
    assert(argc>1); reassigned_registers();
    for(int i=1;i<argc;i++) compare_package(argv[i]);
    return 0;
}
