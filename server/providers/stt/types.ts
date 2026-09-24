// Speech-to-text seam. Local whisper.cpp today; Deepgram / AssemblyAI / a GPU
// pool later, chosen by config. Heavy compute stays out of process.
export interface SttProvider {
  name: string;
  transcribe(samples: Int16Array, sampleRate: number): Promise<{ text: string }>;
}
