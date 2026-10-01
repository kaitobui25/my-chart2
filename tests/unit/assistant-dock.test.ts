import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(path.resolve('examples/workstation/assistant/index.ts'), 'utf8');

describe('assistant dock entry point', () => {
  it('uses a dedicated workspace dock button instead of a right-panel tab', () => {
    expect(source).toContain("dockToggle.id = 'assistant-toggle'");
    expect(source).toContain("createElement('button', 'workspace-dock-button')");
    expect(source).not.toContain("tab.dataset.rightTab = 'assistant'");
    expect(source).toContain("dockToggle.dataset.label = 'AI'");
  });

  it('keeps the AI button directly after Scanner when the scanner module mounts', () => {
    expect(source).toContain("document.getElementById('scanner-toggle')");
    expect(source).toContain("scannerToggle.insertAdjacentElement('afterend', dockToggle)");
    expect(source).toContain('dockObserver.observe(dock, { childList: true })');
  });

  it('opens the existing assistant view and clears active state when the panel closes', () => {
    expect(source).toContain("document.getElementById('right-panel-toggle')?.click()");
    expect(source).toContain("section.hidden = section !== view");
    expect(source).toContain("rightPanelObserver.observe(rightPanel, { attributes: true, attributeFilter: ['hidden'] })");
  });
});
