/* Offline differential renderer: PCM and state after each block. */
#include <assert.h>
#include <stdio.h>
#include "upload.h"
int main(int argc,char **argv) {
    assert(argc==2);uint8_t bytes[TEIA_PACKAGE_MAX];
    FILE *file=fopen(argv[1],"rb"); assert(file);
    size_t size=fread(bytes,1,sizeof bytes,file);fclose(file);
    teia_patch_t patch={0};teia_runtime_t r={0};
    assert(teia_decode(&patch,bytes,(uint32_t)size));assert(teia_load(&r,&patch.program));
    for(unsigned block=0;block<700;block++) {
        if(block%37==0) for(unsigned k=0;k<patch.knob_count;k++) {
            teia_knob_t *v=&patch.knobs[k];
            r.values[v->value]=(block/37)%3==0?v->min:(block/37)%3==1?v->max:(int32_t)(((int64_t)v->min+v->max)/2);
        }
        r.midi_frequency=220*TEIA_Q;r.midi_note=60*TEIA_Q;
        r.midi_gate=block%51<25?TEIA_Q:0;r.midi_trigger_pending=block%51==0;
        teia_prepare_block(&r);
        for(unsigned frame=0;frame<128;frame++) {
            int32_t lr[2];
            teia_sample_prepared(&r,lr,lr+1);
            fwrite(lr,sizeof lr,1,stdout);
        }
        fwrite(r.state,sizeof r.state,1,stdout);
        fwrite(r.feedback,sizeof r.feedback,1,stdout);
        fwrite(r.delay,sizeof r.delay,1,stdout);
        fwrite(r.delay_state,sizeof r.delay_state,1,stdout);
        fwrite(r.delay_slot,sizeof r.delay_slot,1,stdout);
    }
}
