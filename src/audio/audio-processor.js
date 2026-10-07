// AudioWorklet processors (audio thread): 'emulator-audio' plays the samples
// posted by AudioOutput; 'pitch-shift' is the optional pitch effect.
import { PitchShifter } from './pitch-shifter.js';
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

class PitchShiftProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'ratio', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' }];
  }

  constructor() {
    super();
    this.shifter = new PitchShifter(sampleRate);
    this.silence = new Float32Array(128);
  }

  process(inputs, outputs, parameters) {
    const [left, right = left] = inputs[0];
    const [outLeft, outRight = new Float32Array(outLeft.length)] = outputs[0];
    if (this.silence.length < outLeft.length) this.silence = new Float32Array(outLeft.length);
    const silence = this.silence.subarray(0, outLeft.length);
    this.shifter.process(left ?? silence, right ?? silence, outLeft, outRight, parameters.ratio[0]);
    return true;
  }
}

registerProcessor('emulator-audio', EmulatorAudioProcessor);
registerProcessor('pitch-shift', PitchShiftProcessor);
