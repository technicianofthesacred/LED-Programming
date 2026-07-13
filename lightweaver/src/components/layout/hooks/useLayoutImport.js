import { useState, useRef, useCallback } from 'react';
import {
  getPxPerMm,
  measureLayers,
} from '../../../lib/layoutGeometry.js';
import { normalizePatchBoard } from '../../../lib/patchBoard.js';
import { download } from '../../../lib/export.js';

// SVG import (button + drag-drop), project save/load, and import error state.
// `ctx` is the shared layout bundle; view-state resets flow in via `deps`.
export function useLayoutImport(ctx, deps) {
  const {
    strips, setStrips,
    layers, setLayers,
    editCounts, setEditCounts,
    hidden, setHidden,
    svgText, setSvgText,
    viewBox, setViewBox,
    density,
    pxPerMm, setPxPerMm,
    layerGroups, layerOrder, setLayerGroups, setLayerOrder,
    setPatchBoard,
    pushLayoutHistory,
    clearLayoutSelection,
    serializeProject, loadProject: replaceProject,
    colorIdxRef, nextColor,
  } = ctx;

  const { resetView, setDrawMode, setWaypoints } = deps;

  const [error, setError]       = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef(null);
  const loadRef = useRef(null);

  // ── File processing (shared by button + drag-drop) ─────────────────────────
  const processFile = useCallback(async (file) => {
    setError(null);
    if (!file.name.toLowerCase().endsWith('.svg')) {
      setError('Only .svg files are supported. In Illustrator: File → Export As → SVG.');
      return;
    }
    const text = await file.text();
    if (!text.includes('<svg') && !text.includes('<SVG')) {
      setError('This does not appear to be a valid SVG file.');
      return;
    }
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const srcSvg = doc.querySelector('svg');
    if (!srcSvg) { setError('Could not parse SVG.'); return; }
    const parseErr = doc.querySelector('parsererror');
    if (parseErr) { setError('SVG parse error: ' + parseErr.textContent.slice(0, 120)); return; }

    const vb = srcSvg.getAttribute('viewBox') || '0 0 640 400';
    const newPxPerMm = getPxPerMm(srcSvg);
    colorIdxRef.current = 0;
    const parsed = measureLayers(doc);
    if (!parsed.length) {
      setError('No layers found. In Illustrator use File → Export As → SVG (not Save As).');
      return;
    }
    const newLayers = parsed.map(l => ({ ...l, _color: nextColor(), _emit: 'dir', _angle: 0 }));
    const newLayerOrder = parsed.map(l => ({ type: 'layer', id: l.layerId }));
    pushLayoutHistory();
    setViewBox(vb);
    setPxPerMm(newPxPerMm);
    setSvgText(text);
    setLayers(newLayers);
    setStrips([]);
    setPatchBoard(normalizePatchBoard(null, []));
    setEditCounts({});
    setHidden({});
    setLayerGroups([]);
    setLayerOrder(newLayerOrder);
    clearLayoutSelection();
    setDrawMode(false);
    setWaypoints([]);
    resetView();
  }, [strips, layers, editCounts, hidden, svgText, viewBox, density, pushLayoutHistory, setPatchBoard, clearLayoutSelection]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleFile = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
    await processFile(file);
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDragOver(true);
  };
  const handleDragLeave = (e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false);
  };
  const handleDrop = async (e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) await processFile(file);
  };

  // ── Save / Load project ────────────────────────────────────────────────────
  const saveProject = () => {
    const date = new Date().toISOString().slice(0, 10);
    const data = {
      ...serializeProject(),
      layout: {
        ...serializeProject().layout,
        strips,
        layers,
        svgText,
        viewBox,
        density,
        pxPerMm,
        editCounts,
        hidden,
        layerGroups,
        layerOrder,
      },
    };
    // Canonical download() (src/lib/export.js): (content, filename, mimeType).
    download(JSON.stringify(data, null, 2), `lightweaver-project-${date}.json`, 'application/json');
  };

  const handleLoad = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const result = await replaceProject(data);
      if (result.reason === 'invalid') alert('Unrecognised file format.');
    } catch (err) {
      alert('Could not load file: ' + err.message);
    }
  };

  return {
    error, setError,
    dragOver,
    fileRef, loadRef,
    processFile,
    handleFile,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    saveProject,
    handleLoad,
  };
}
