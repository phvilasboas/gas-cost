(function exposeCalculations(root, factory) {
  const calculations = factory();
  if (typeof module === 'object' && module.exports) module.exports = calculations;
  root.GasCostCalculations = calculations;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  function hasOdometer(entry) {
    return entry.odometer !== null && entry.odometer !== undefined && entry.odometer !== '' && Number.isFinite(Number(entry.odometer));
  }

  function compareEntriesChronologically(a, b) {
    return a.date.localeCompare(b.date)
      || String(a.time || '').localeCompare(String(b.time || ''))
      || String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
  }

  function compareEntriesNewestFirst(a, b) {
    return compareEntriesChronologically(b, a);
  }

  function calculateConsumption(entries) {
    const ordered = [...entries].sort(compareEntriesChronologically);
    const samples = [];
    let previousFull = null;
    let liters = 0;
    let amount = 0;

    for (const entry of ordered) {
      if (!previousFull) {
        if (entry.fullTank && hasOdometer(entry)) previousFull = entry;
        continue;
      }

      // Todo combustível colocado depois do tanque cheio inicial pertence ao ciclo,
      // mesmo que o abastecimento seja parcial e não possua hodômetro.
      liters += Number(entry.liters);
      amount += Number(entry.amount);

      // Somente um novo tanque completo com hodômetro encerra o ciclo.
      if (!entry.fullTank || !hasOdometer(entry)) continue;

      const distance = Number(entry.odometer) - Number(previousFull.odometer);
      if (distance <= 0 || liters <= 0) continue;

      samples.push({
        entryId: entry.id,
        date: entry.date,
        distance,
        liters,
        amount,
        kmPerLiter: distance / liters,
        costPerKm: amount / distance,
      });
      previousFull = entry;
      liters = 0;
      amount = 0;
    }

    const totalDistance = samples.reduce((sum, sample) => sum + sample.distance, 0);
    const totalLiters = samples.reduce((sum, sample) => sum + sample.liters, 0);
    const totalAmount = samples.reduce((sum, sample) => sum + sample.amount, 0);
    return {
      samples,
      kmPerLiter: totalLiters ? totalDistance / totalLiters : null,
      costPerKm: totalDistance ? totalAmount / totalDistance : null,
    };
  }

  return { calculateConsumption, compareEntriesChronologically, compareEntriesNewestFirst };
}));
