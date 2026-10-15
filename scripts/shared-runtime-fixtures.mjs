// Compile real editor graphs to reusable Rust/WASM equivalence fixtures. No app.
import { build } from 'esbuild';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const out = 'rust/teia-kernel/tests/fixtures';
await mkdir(out, { recursive: true });
const bundle = '/tmp/teia-shared-fixture-compiler.mjs';
await build({ stdin: { contents: `export {preparePatch} from './editor/src/hosted/compiler'; export {NODE_DEFINITIONS} from './editor/src/graph/nodeTypes';`, resolveDir: process.cwd() }, outfile: bundle, bundle: true, platform: 'node', format: 'esm' });
const { preparePatch, NODE_DEFINITIONS } = await import(pathToFileURL(bundle));
const node = (type, id='n', params={}) => ({ id, type, params: { ...Object.fromEntries(NODE_DEFINITIONS[type].inputs.map(p=>[p.name,p.defaultValue??0])), ...params } });
const link=(a,ap,b,bp,mode='set')=>({from:{node:a,port:ap},to:{node:b,port:bp},mode});
const cases=[];
for (const [type, definition] of Object.entries(NODE_DEFINITIONS)) {
  if (['Expression','Group','Spread','Spawn','Ins','Outs','Params','Send','Receive','AudioOut','FFT','CustomWave','SamplePlayer','Image','MidiNote','MidiNoteOn','MidiNoteOff','Keys','Tempo','MidiNoteOnSend','MidiNoteOffSend','MidiCcSend'].includes(type)) continue;
  const port=definition.outputs[0]?.name; if (!port) continue;
  const nodes=[node(type),node('AudioOut','out')];
  const links=[link('n',port,'out','both')];
  if (definition.inputs.some(p=>p.name==='signal')) { nodes.push(node('SineOsc','source'));links.push(link('source','signal','n','signal')); }
  if(type==='Noise'||type==='Random'||type==='SampleHoldOsc'||type==='PerlinNoise') continue; // exact random seed is tested separately
  cases.push({name:type,nodes,links});
}
cases.push({name:'bend phase reset modulation',nodes:[node('SineOsc','a',{frequency:10}),node('SineOsc'),node('AudioOut','out')],links:[link('a','signal','n','frequency','bend'),link('a','signal','n','phase'),link('n','signal','out','both')]});
cases.push({name:'spread oscillator',nodes:[{...node('Spread','repeat',{count:3}),spreadNodeIds:['n']},node('SineOsc'),node('AudioOut','out')],links:[link('n','signal','out','both')]});
for (const type of ['CustomWave','SamplePlayer','Image']) {
  const source=node(type);
  if(type==='SamplePlayer')source.sample={name:'fixture',url:'fixture:sample'};
  if(type==='Image')source.image={name:'fixture',url:'fixture:image'};
  cases.push({name:type,nodes:[source,node('AudioOut','out')],links:[link('n',type==='Image'?'r':'signal','out','both')]});
}
const f=n=>Number.isInteger(n)?`${n}.0`:String(n);
const rustOp=op=>`Operation {${['opcode','out','a','b','c','d','e','state'].map(k=>`${k}:${op[k]??-1}`).join(',')},${['value','value2','value3','value4'].map(k=>`${k}:${f(op[k]??0)}`).join(',')}}`;
const fixtures=[];
for(const patch of cases){const result=preparePatch(patch,{profile:'native-scalar-v1'});if(!('program'in result)||result.diagnostics.some(d=>d.severity==='error')) throw new Error(`${patch.name}: ${JSON.stringify(result.diagnostics)}`);fixtures.push({name:patch.name,...result.program});}
// Hand-authored program fixtures exercise nested runtime structure independently
// of editor expansion. They supplement, and are labelled separately from, graphs.
for (const outerSpawn of [false,true]) for (const innerSpawn of [false,true]) {
  const op=(opcode,out=-1,a=-1,b=-1,extra={})=>({opcode,out,a,b,c:-1,d:-1,e:-1,state:-1,value:0,value2:0,value3:0,value4:0,...extra});
  fixtures.push({ ...fixtures[0], name:`wire nested ${outerSpawn?'spawn':'spread'} ${innerSpawn?'spawn':'spread'}`, values:[2,0.125],
    sampleBindings:[],imageBindings:[],customWaveBindings:[],sequencerBindings:[],fftBindings:[],
    repeatBindings:[{id:'outer'},{id:'inner'}],
    ops:[op(0,0,0),op(0,1,1),op(outerSpawn?46:42,2,0,7,{state:0,value2:1}),op(innerSpawn?46:42,3,0,6,{state:0,value:1,value2:1}),op(37,4,-1,-1,{state:0}),op(5,-1,1,0),op(innerSpawn?47:45),op(outerSpawn?47:45)] });
}
await writeFile(`${out}/shared.json`,JSON.stringify(fixtures));
const resources=p=>`Resources { repeat_capacity:Some(8), repeat_memory_budget:64*1024*1024,
  samples:vec![${p.sampleBindings.map(b=>`Sample {sample_rate:48000.0,release:${f(b.release)},samples:(0..512).map(|i| (i as f32*0.1).sin()).collect()}`).join(',')}],
  images:vec![${p.imageBindings.map(()=>`Image {width:1,height:1,rgba:vec![128,64,255,255]}`).join(',')}],
  custom_waves:vec![${p.customWaveBindings.map(b=>`CustomWave {mode:0,sustain_start:0.5,sustain_end:0.75,points:vec![${b.customWave.points.map(v=>`(${f(v.x)},${f(v.y)})`).join(',')}]}`).join(',')}],
  sequencers:vec![${p.sequencerBindings.map(b=>`Sequencer {gate_mode:${b.mode==='gate'},steps:${b.steps},rows:vec![${b.events.map(row=>`vec![${row.map(e=>`SequenceEvent {active:${e.active},start:${f(e.start)},end:${f(e.end)},velocity:${f(e.velocity)},note:${f(e.note??0)}}`).join(',')}]`).join(',')}]}`).join(',')}], ..Resources::default() }`;
await writeFile(`${out}/shared.rs`,'// Generated by scripts/shared-runtime-fixtures.mjs; do not edit.\nfn fixtures() -> Vec<(&\'static str, Vec<Operation>, Vec<f64>, Resources)> { vec![\n'+fixtures.map(p=>`(${JSON.stringify(p.name)},vec![${p.ops.map(rustOp).join(',')}],vec![${p.values.map(f).join(',')}],${resources(p)})`).join(',\n')+'\n] }\n');
console.log(`Compiled ${fixtures.length} fixtures (compiled graphs plus labelled nested wire fixtures).`);

await mkdir('rust/teia-kernel/examples/support',{recursive:true});
const sources=(await readdir('rust/teia-kernel/src')).filter(p=>/\.(rs|json)$/.test(p)).sort();
await writeFile('rust/teia-kernel/examples/support/source_stamp.rs','// Generated source list; include_bytes embeds the actual compiled source.\nconst SOURCES: &[(&str,&[u8])] = &[\n'+sources.map(p=>`(${JSON.stringify(p)},include_bytes!(${JSON.stringify('../../src/'+p)}))`).join(',\n')+'\n];\n');
