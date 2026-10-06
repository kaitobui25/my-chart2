import { createSmcIndicator } from './smart-money-concepts-v2';
import { calculateSmartMoneyConceptsV3 } from './smart-money-concepts-v3-model';

const def = createSmcIndicator({
  id: 'smart-money-concepts-v3', name: 'SMC V3 · Super SMC', title: 'SMC V3', order: 15,
}, calculateSmartMoneyConceptsV3);

// Protected Swing structure is the primary feature of V3.
def.params = def.params?.map(param => param.key === 'showSwing' ? { ...param, default: true } : param);

export default def;
