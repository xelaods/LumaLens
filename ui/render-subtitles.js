'use strict';
// Shared by the preview and the transparent desktop overlay.
window.renderSubtitles = function(container, result, settings) {
  container.replaceChildren();
  container.className = `${container.id === 'desktopOverlay' ? 'desktop-overlay' : 'preview-overlay'} style-${settings.style}`;
  container.style.setProperty('--subtitle-size', `${settings.fontSize}px`);
  container.style.setProperty('--subtitle-opacity', String(settings.opacity / 100));
  if (!result?.regions?.length) return;
  if (settings.overlayMode === 'positioned' || settings.coverOriginal) {
    const area = result.region || { x: 0, y: 0, width: 1, height: 1 };
    for (const region of result.regions) {
      const box = region.box; if (!box) continue;
      const node = document.createElement('div'); node.className = `positioned-text ${settings.style === 'manga' ? 'manga' : ''} ${settings.coverOriginal ? 'original-cover' : ''}`;
      node.style.left = `${(area.x + box.x * area.width) * 100}%`; node.style.top = `${(area.y + box.y * area.height) * 100}%`;
      node.style.width = `${box.width * area.width * 100}%`; node.style.minHeight = `${box.height * area.height * 100}%`;
      node.style.maxHeight = `${Math.max(3, (1 - area.y - box.y * area.height) * 100)}%`;
      node.textContent = region.translation;
      container.append(node);
    }
  } else {
    const group = document.createElement('div'); group.className = 'preview-subtitles';
    if (settings.showOriginal) { const original = document.createElement('div'); original.className = 'translated-text original'; original.textContent = result.regions.map(r => r.text).join('\n'); group.append(original); }
    const translated = document.createElement('div'); translated.className = 'translated-text'; translated.textContent = result.regions.map(r => r.translation).join('\n'); group.append(translated); container.append(group);
  }
};
