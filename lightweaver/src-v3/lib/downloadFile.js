function extensionForFilename(filename = '') {
  const match = String(filename).match(/\.([a-z0-9]+)$/i);
  return match ? `.${match[1].toLowerCase()}` : '';
}

async function saveWithFilePicker(filename, blob, {
  showSaveFilePicker = globalThis.showSaveFilePicker,
} = {}) {
  if (typeof showSaveFilePicker !== 'function') return false;

  const handle = await showSaveFilePicker({
    suggestedName: filename,
    types: [{
      description: 'Lightweaver file',
      accept: {
        [blob.type || 'application/octet-stream']: [extensionForFilename(filename) || '.txt'],
      },
    }],
  });
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
  return true;
}

function downloadWithAnchor(filename, blob, {
  document: doc = globalThis.document,
  URL: urlApi = globalThis.URL,
} = {}) {
  if (!doc?.createElement || !doc?.body || !urlApi?.createObjectURL) return false;

  const url = urlApi.createObjectURL(blob);
  const link = doc.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';

  try {
    doc.body.appendChild(link);
    link.click();
    return true;
  } finally {
    if (link.isConnected !== false) {
      try { doc.body.removeChild(link); } catch {}
    }
    urlApi.revokeObjectURL?.(url);
  }
}

export async function downloadTextFile(filename, text, {
  type = 'text/plain',
  preferPicker = true,
  ...options
} = {}) {
  const blob = new Blob([text], { type });
  if (preferPicker) {
    try {
      if (await saveWithFilePicker(filename, blob, options)) return true;
    } catch (error) {
      if (error?.name === 'AbortError') return false;
    }
  }

  return downloadWithAnchor(filename, blob, options);
}

export async function downloadJsonFile(filename, data, options = {}) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return downloadTextFile(filename, text, {
    ...options,
    type: 'application/json',
  });
}
