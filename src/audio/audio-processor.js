// AudioWorklet processor: runs on the audio thread and plays the samples
// posted by AudioOutput.
import { Resampler } from './resampler.js';

class EmulatorAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.resampler = new Resampler(sampleRate);
    this.port.onmessage = ({ data }) => {
      if (data.type === 'samples') {
        this.resampler.setInputRate(data.rate);
        this.resampler.write(data.samples);
      } else if (data.type === 'clear') {
        this.resampler.clear();
      }
    };
  }

  process(_inputs, outputs) {
    const [left, right] = outputs[0];
    this.resampler.process(left, right ?? new Float32Array(left.length));
    return true;
  }
}

registerProcessor('emulator-audio', EmulatorAudioProcessor);
