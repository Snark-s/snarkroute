"""Lightweight H3 cyclic patch contract test, never load H3 model weights."""
import sys, inspect
from pathlib import Path
root = Path('/home/serge/h3/runtime/snarkroute-h3')
sys.path.insert(0,str(root))
sys.path.insert(0,'/home/serge/h3/runtime/comfyui-core')
import torch
from importlib.util import spec_from_file_location, module_from_spec
spec=spec_from_file_location('h3_cyclic',root/'app/backends/h3_cyclic.py')
mod=module_from_spec(spec)
spec.loader.exec_module(mod)
_diffusion_wrapper, _periodic, audio_latents, attach_cyclic_sampler = mod._diffusion_wrapper, mod._periodic, mod.audio_latents, mod.attach_cyclic_sampler
from comfy_extras.nodes_audio import VAEDecodeAudio, vae_decode_audio

print("torch",torch.__version__)
print("decoder-node",inspect.signature(VAEDecodeAudio.execute))
print("decoder-function",inspect.signature(vae_decode_audio))
for clips in [1,6,7]:
    count=clips*5+2
    na=audio_latents(clips)
    v=torch.rand(1,4,count,3,3)
    a=torch.rand(1,2,1,na+2)
    opts={
      'h3_cyclic_pad':1,'h3_cyclic_views':2,
      'h3_cyclic_noise_delta':torch.zeros_like(v),
      'sigmas':torch.tensor([.75])
    }
    calls=[]
    def executor(x,timestep,context,transformer_options,**kwargs):
        calls.append((list(x[0].shape),list(x[1].shape)))
        return [torch.zeros_like(x[0]),torch.zeros_like(x[1])]
    out=_diffusion_wrapper(executor,[v,a],None,None,opts)
    assert list(out[0].shape)==list(v.shape), (out[0].shape,v.shape)
    assert list(out[1].shape)==list(a.shape), (out[1].shape,a.shape)
    print("clips",clips,"output shapes",[list(x.shape) for x in out],"executor shapes",calls)
# The real ComfyUI t2va conditioning must tolerate no VAE in text-only mode.
from comfy_extras.nodes_minimax_h3 import MiniMaxH3ImageToVideo
class FakeClip:
    def tokenize(self, prompt, images=None):
        return {"dummy": prompt}
    def encode_from_tokens_scheduled(self, tokens):
        return [[torch.zeros(1,1,1), {}]]
output=MiniMaxH3ImageToVideo.execute(FakeClip(), None, "a calm sea",800,448,107)
assert len(output.result)==2
print("TEXT_ONLY_WITHOUT_VAE_PASS",flush=True)
print("TEST_SUCCESS",flush=True)
