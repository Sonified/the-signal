// Compiles the WGSL inside a page (the template literal assigned to
// `const WGSL = \``) with Deno's WebGPU, which uses naga: a pass here is not
// a guarantee in Chrome (Tint), but a failure is a real error. Bitwise
// operators mixed with arithmetic must be parenthesised for both.
//   deno run --allow-read --unstable-webgpu tools/wgsl-check.mjs tools/gap-explorer.html
const file = Deno.args[0];
const html = await Deno.readTextFile(file);
const start = html.indexOf('const WGSL = `');
if (start < 0) { console.error('no `const WGSL = `` in ' + file); Deno.exit(2); }
// Deno's naga has no texture_external (Chrome's zero-copy video texture):
// an ordinary 2D texture stands in, which textureSampleBaseClampToEdge also
// takes, so everything else is still checked.
const code = html.slice(start + 14, html.indexOf('`;', start + 14)).replaceAll('texture_external', 'texture_2d<f32>');
const adapter = await navigator.gpu.requestAdapter();
const device = await adapter.requestDevice();
device.pushErrorScope('validation');
const mod = device.createShaderModule({ code });
const info = await mod.getCompilationInfo();
for (const m of info.messages) console.log(m.type + ' line ' + m.lineNum + ': ' + m.message);
const err = await device.popErrorScope();
if (err) { console.error('validation: ' + err.message); Deno.exit(1); }
console.log('WGSL ok: ' + file);
