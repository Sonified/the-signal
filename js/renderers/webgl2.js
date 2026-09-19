// ---------- WebGL2 ----------
import { layers, LUT_N } from '../state.js';
import { cv } from '../dom.js';
import { GL_VS_FULL, GL_FS_FULL, GL_VS_EDGE, GL_FS_EDGE } from '../shaders.js';
import { uniArr, lutArr, edgeArr, edgeInst, buildFrameData } from '../framedata.js';

function glProgram(gl, vsrc, fsrc) {
  const mk = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn('shader compile failed:', gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  };
  const vs = mk(gl.VERTEX_SHADER, vsrc), fs = mk(gl.FRAGMENT_SHADER, fsrc);
  if (!vs || !fs) return null;
  const p = gl.createProgram();
  gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
  gl.deleteShader(vs); gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.warn('program link failed:', gl.getProgramInfoLog(p));
    return null;
  }
  return p;
}

export function initWebGL2() {
  let gl = null;
  try {
    gl = cv.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: true, preserveDrawingBuffer: false,
      desynchronized: true, powerPreference: 'high-performance'
    });
  } catch (e) { return null; }
  if (!gl) return null;

  const pFull = glProgram(gl, GL_VS_FULL, GL_FS_FULL);
  const pEdge = glProgram(gl, GL_VS_EDGE, GL_FS_EDGE);
  if (!pFull || !pEdge) return null;

  const U = (p) => ({
    res: gl.getUniformLocation(p, 'uRes'),
    col: gl.getUniformLocation(p, 'uCol'),
    fieldP: gl.getUniformLocation(p, 'uFieldP'),
    cornerA: gl.getUniformLocation(p, 'uCornerA'),
    misc: gl.getUniformLocation(p, 'uMisc'),
    misc2: gl.getUniformLocation(p, 'uMisc2'),
    lut: gl.getUniformLocation(p, 'uLut')
  });
  const uF = U(pFull), uE = U(pEdge);

  // 1D radial profile, sampled with texelFetch so no float-filtering
  // extension is required.
  const lutTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, lutTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, LUT_N, 1);

  const emptyVao = gl.createVertexArray();
  const edgeVao = gl.createVertexArray();
  const edgeBuf = gl.createBuffer();
  gl.bindVertexArray(edgeVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, edgeBuf);
  gl.bufferData(gl.ARRAY_BUFFER, edgeArr.byteLength, gl.DYNAMIC_DRAW);
  [['aP0', 0], ['aP1', 8], ['aWA', 16]].forEach(([nm, off]) => {
    const loc = gl.getAttribLocation(pEdge, nm);
    if (loc < 0) return;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 24, off);
    gl.vertexAttribDivisor(loc, 1);
  });
  gl.bindVertexArray(null);

  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.SCISSOR_TEST);
  gl.clearColor(0, 0, 0, 1);

  let vw = -1, vh = -1;
  function setUniforms(u) {
    gl.uniform4f(u.res, uniArr[0], uniArr[1], uniArr[2], uniArr[3]);
    gl.uniform4f(u.col, uniArr[4], uniArr[5], uniArr[6], uniArr[7]);
    gl.uniform4f(u.fieldP, uniArr[8], uniArr[9], uniArr[10], uniArr[11]);
    gl.uniform4f(u.cornerA, uniArr[12], uniArr[13], uniArr[14], uniArr[15]);
    gl.uniform4f(u.misc, uniArr[16], uniArr[17], uniArr[18], uniArr[19]);
    gl.uniform4f(u.misc2, uniArr[20], uniArr[21], uniArr[22], uniArr[23]);
  }

  return {
    name: 'WebGL2',
    resize() { vw = -1; },
    draw(lum) {
      if (gl.isContextLost()) return;
      buildFrameData(lum);
      if (vw !== cv.width || vh !== cv.height) {
        vw = cv.width; vh = cv.height;
        gl.viewport(0, 0, vw, vh);
      }

      gl.disable(gl.BLEND);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.useProgram(pFull);
      setUniforms(uF);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, lutTex);
      if (layers.rings) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, LUT_N, 1, gl.RED, gl.FLOAT, lutArr);
      gl.uniform1i(uF.lut, 0);
      gl.bindVertexArray(emptyVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      if (edgeInst) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.useProgram(pEdge);
        setUniforms(uE);
        gl.bindVertexArray(edgeVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, edgeBuf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, edgeArr, 0, edgeInst * 6);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, edgeInst);
      }
      gl.bindVertexArray(null);
    }
  };
}
