/**
 * The ESP32 ADC's voltage transfer at 12 dB attenuation (what analogRead uses), with default
 * eFuse calibration: ESP-IDF 5.5's line fitting on the classic ESP32 (nominal 1100 mV Vref) and
 * curve fitting on the ESP32-C3. The emulator converts with the same curves, so a program that
 * turns counts into millivolts this way reads the same voltage in the simulator and (within a
 * chip's calibration spread) on a real board.
 */
export type AdcChip = 'esp32' | 'esp32c3';

// esp_adc/esp32c3/curve_fitting_coefficients.c, atten 3: error = sum(c[i] * v^i), v in mV.
const C3_ERROR = [-1.4912262772850453, -0.0228549975564099, 3.56391935717e-5, -1.79964582e-8, 4.2046e-12];

/** Calibrated millivolts for a 12-bit count. */
export function adcMillivolts(raw: number, chip: AdcChip = 'esp32'): number {
  if (chip === 'esp32c3') {
    const v = (raw * 1370) / 2000;
    if (v === 0) return 0;
    let error = 0;
    let power = 1;
    for (const c of C3_ERROR) { error += c * power; power *= v; }
    return v - error;
  }
  return (raw * 1100 * 196602) / 4096 / 65536 + 142;
}

/** The count a voltage reads as (the inverse of adcMillivolts, clamped to 0..4095). */
export function adcRaw(millivolts: number, chip: AdcChip = 'esp32'): number {
  let lo = 0;
  let hi = 4095;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (adcMillivolts(mid, chip) < millivolts) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(adcMillivolts(lo - 1, chip) - millivolts) < Math.abs(adcMillivolts(lo, chip) - millivolts)) lo--;
  return lo;
}

/**
 * The same conversion as AssemblyScript source, for programs: `function adcMillivolts(raw: i32): f64`.
 * Programs are compiled per board, so the curve is baked in for the board's chip.
 */
export function adcMillivoltsSource(chip: AdcChip): string {
  if (chip === 'esp32c3') {
    return `// The ESP32-C3 ADC at 12 dB, default calibration (ESP-IDF curve fitting): counts to millivolts.
function adcMillivolts(raw: i32): f64 {
  const v = <f64>raw * 1370.0 / 2000.0;
  if (v == 0) return 0;
  return v - (-1.4912262772850453 - 0.0228549975564099 * v + 3.56391935717e-5 * v * v - 1.79964582e-8 * v * v * v + 4.2046e-12 * v * v * v * v);
}`;
  }
  return `// The ESP32 ADC at 12 dB, default calibration (ESP-IDF line fitting, Vref 1100 mV): counts to millivolts.
function adcMillivolts(raw: i32): f64 { return <f64>raw * 0.80563 + 142.0; }`;
}
