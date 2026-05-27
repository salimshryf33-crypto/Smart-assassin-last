export function useSounds() {
  const playTone = (freq: number, duration: number, type: OscillatorType = 'sine') => {
    try {
      const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + duration);
    } catch {
      // Audio not available
    }
  };

  return {
    onFlashcardFlipSound: () => playTone(440, 0.1),
    onSuccessSound: () => playTone(880, 0.15),
    onTickSound: () => playTone(600, 0.05, 'square'),
    onCompleteSound: () => playTone(1000, 0.3),
  };
}
