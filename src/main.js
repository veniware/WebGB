import { Emulator } from './app/emulator.js';
import { loadSettings } from './app/settings.js';
import { AudioOutput } from './audio/audio-output.js';
import { CameraInput } from './input/camera.js';
import { GamepadInput } from './input/gamepad.js';
import { InputManager } from './input/input-manager.js';
import { KeyboardInput } from './input/keyboard.js';
import { MotionInput } from './input/motion.js';
import { Rumble } from './input/rumble.js';
import { TouchInput } from './input/touch.js';
import { setupUI } from './ui/ui.js';
import { Display } from './video/display.js';

const settings = loadSettings();
const display = new Display(
  document.getElementById('screen'),
  document.getElementById('stage'),
  document.getElementById('play-area'),
);
const audio = new AudioOutput();

let ui;
const keyboard = new KeyboardInput({ onHotkey: (name) => ui.hotkey(name) });
const touch = new TouchInput(document.getElementById('touch-controls'));
const gamepad = new GamepadInput();
const motion = new MotionInput({ onNeedsPermission: () => ui.needMotionPermission(motion) });
const input = new InputManager([keyboard, gamepad, touch, motion]);

const emulator = new Emulator({
  display,
  audio,
  input,
  motion,
  camera: new CameraInput(),
  rumble: new Rumble({ gamepad }),
});
ui = setupUI({ emulator, display, audio, inputs: [keyboard, touch], settings });
emulator.start();

// Debugging handle for the browser console and automated browser tests.
window.webgb = { emulator, display, audio, inputs: [keyboard, touch] };
