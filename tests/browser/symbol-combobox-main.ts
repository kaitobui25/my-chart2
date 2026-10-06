import { createSymbolCombobox } from '../../examples/excel-content-addin/symbol-combobox';

let symbols = ['7203.T', '6758.T', '9984.T'];
let searchCalls = 0;
const commits: string[] = [];

const root = requiredElement<HTMLElement>('#symbol-control');
const input = requiredElement<HTMLInputElement>('#symbol-input');
const menu = requiredElement<HTMLElement>('#symbol-menu');
const trigger = requiredElement<HTMLButtonElement>('#symbol-trigger');

createSymbolCombobox({
  root,
  input,
  menu,
  trigger,
  getSymbols: () => symbols,
  debounceMs: 0,
  search: async () => {
    searchCalls += 1;
    return [{ symbol: '8306.T', name: 'Mitsubishi UFJ', exchange: 'TSE' }];
  },
  onCommit: (symbol) => commits.push(symbol),
  onError: (message) => { throw new Error(message); },
});

window.symbolComboboxTest = {
  setSymbols(nextSymbols) {
    symbols = [...nextSymbols];
  },
  state() {
    return {
      searchCalls,
      commits: [...commits],
      expanded: input.getAttribute('aria-expanded'),
    };
  },
};

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing symbol combobox fixture element: ${selector}`);
  return element;
}

declare global {
  interface Window {
    symbolComboboxTest: {
      setSymbols(symbols: string[]): void;
      state(): {
        searchCalls: number;
        commits: string[];
        expanded: string | null;
      };
    };
  }
}
