const PESEWAS_PER_GHS = 100;

const toPesewas = (ghs) => Math.round(Number(ghs) * PESEWAS_PER_GHS);

const fromPesewas = (pesewas) => Number((pesewas / PESEWAS_PER_GHS).toFixed(2));

const MIN_MOOLRE_FEE = 50; // GHS 0.50
const MAX_MOOLRE_FEE = 1000; // GHS 10.00
const MAX_NETWORK_FEE_MOMO = 2000; // GHS 20.00
const MAX_NETWORK_FEE_BANK = 500; // GHS 5.00

export const calculateFeesPesewas = (amountPesewas, method) => {
  const amount = Math.max(0, Math.round(Number(amountPesewas) || 0));
  let moolreFee = 0;
  let networkFee = 0;

  switch (method) {
    case "momo_collection": {
      moolreFee = Math.round(amount * 0.01);
      if (moolreFee < MIN_MOOLRE_FEE) moolreFee = MIN_MOOLRE_FEE;
      if (moolreFee > MAX_MOOLRE_FEE) moolreFee = MAX_MOOLRE_FEE;
      networkFee = Math.round(amount * 0.01);
      if (networkFee > MAX_NETWORK_FEE_MOMO) networkFee = MAX_NETWORK_FEE_MOMO;
      break;
    }
    case "momo_payout": {
      moolreFee = Math.round(amount * 0.01);
      if (moolreFee < MIN_MOOLRE_FEE) moolreFee = MIN_MOOLRE_FEE;
      if (moolreFee > MAX_MOOLRE_FEE) moolreFee = MAX_MOOLRE_FEE;
      networkFee = 0;
      break;
    }
    case "bank_collection": {
      moolreFee = 0;
      networkFee = Math.round(amount * 0.01);
      if (networkFee > MAX_NETWORK_FEE_BANK) networkFee = MAX_NETWORK_FEE_BANK;
      break;
    }
    case "moolre_wallet": {
      moolreFee = 0;
      networkFee = 0;
      break;
    }
    default:
      throw new Error(`Unknown Moolre payment method: ${method}`);
  }

  return {
    moolreFee,
    networkFee,
    totalFee: moolreFee + networkFee,
  };
};

export const calculateMoolreFees = (amountGhs, method) => {
  const amountPesewas = toPesewas(amountGhs);
  const fees = calculateFeesPesewas(amountPesewas, method);
  return {
    moolreFee: fromPesewas(fees.moolreFee),
    networkFee: fromPesewas(fees.networkFee),
    totalFee: fromPesewas(fees.totalFee),
  };
};

export const calculatePassThroughCheckout = (baseAmountGhs, method) => {
  const basePesewas = toPesewas(baseAmountGhs);

  let grossPesewas = basePesewas;
  for (let i = 0; i < 1000; i += 1) {
    const fees = calculateFeesPesewas(grossPesewas, method);
    const nextGross = basePesewas + fees.totalFee;
    if (nextGross === grossPesewas) {
      grossPesewas = nextGross;
      break;
    }
    grossPesewas = nextGross;
  }

  const fees = calculateFeesPesewas(grossPesewas, method);
  const totalFee = fees.totalFee;
  const totalToPay = grossPesewas;
  const netSettled = totalToPay - totalFee;

  return {
    method,
    baseAmount: fromPesewas(basePesewas),
    moolreFee: fromPesewas(fees.moolreFee),
    networkFee: fromPesewas(fees.networkFee),
    totalFee: fromPesewas(totalFee),
    totalToPay: fromPesewas(totalToPay),
    netSettled: fromPesewas(netSettled),
  };
};

const moolreFeeCalculator = {
  calculateMoolreFees,
  calculatePassThroughCheckout,
  calculateFeesPesewas,
  PESEWAS_PER_GHS,
};

export default moolreFeeCalculator;
export { moolreFeeCalculator };
