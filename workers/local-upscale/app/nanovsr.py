"""NanoVSR architecture adapted from the official MIT-licensed repository.

Source: https://github.com/filippawlicki/nanovsr at
b48e2bad89d01e22226eb8613bee25cb45623fae.
"""

from __future__ import annotations

import numpy as np


def load_nanovsr(checkpoint_path, device: str, use_fp16: bool):
    import torch
    import torch.nn as nn
    import torch.nn.functional as functional

    class RepVGGBlock(nn.Module):
        def __init__(self, in_channels: int, out_channels: int, deploy: bool = False):
            super().__init__()
            self.deploy = deploy
            self.in_channels = in_channels
            self.activation = nn.LeakyReLU(0.1, inplace=True)
            if deploy:
                self.rbr_reparam = nn.Conv2d(in_channels, out_channels, 3, padding=1, bias=True)
            else:
                self.rbr_identity = nn.BatchNorm2d(in_channels) if out_channels == in_channels else None
                self.rbr_dense = nn.Sequential(
                    nn.Conv2d(in_channels, out_channels, 3, padding=1, bias=False),
                    nn.BatchNorm2d(out_channels),
                )
                self.rbr_1x1 = nn.Sequential(
                    nn.Conv2d(in_channels, out_channels, 1, bias=False),
                    nn.BatchNorm2d(out_channels),
                )

        def forward(self, value):
            if self.deploy:
                return self.activation(self.rbr_reparam(value))
            identity = 0 if self.rbr_identity is None else self.rbr_identity(value)
            return self.activation(self.rbr_dense(value) + self.rbr_1x1(value) + identity)

        def _fuse(self, branch):
            if branch is None:
                return 0, 0
            if isinstance(branch, nn.Sequential):
                kernel = branch[0].weight
                batch_norm = branch[1]
            else:
                batch_norm = branch
                if not hasattr(self, "id_tensor"):
                    kernel_value = np.zeros((self.in_channels, self.in_channels, 3, 3), dtype=np.float32)
                    for index in range(self.in_channels):
                        kernel_value[index, index, 1, 1] = 1
                    self.id_tensor = torch.from_numpy(kernel_value).to(batch_norm.weight.device)
                kernel = self.id_tensor
            std = (batch_norm.running_var + batch_norm.eps).sqrt()
            scale = (batch_norm.weight / std).reshape(-1, 1, 1, 1)
            return kernel * scale, batch_norm.bias - batch_norm.running_mean * batch_norm.weight / std

        def switch_to_deploy(self):
            if self.deploy:
                return
            kernel3, bias3 = self._fuse(self.rbr_dense)
            kernel1, bias1 = self._fuse(self.rbr_1x1)
            kernel_id, bias_id = self._fuse(self.rbr_identity)
            kernel1 = functional.pad(kernel1, [1, 1, 1, 1])
            self.rbr_reparam = nn.Conv2d(
                self.rbr_dense[0].in_channels,
                self.rbr_dense[0].out_channels,
                3,
                padding=1,
                bias=True,
            )
            self.rbr_reparam.weight.data = kernel3 + kernel1 + kernel_id
            self.rbr_reparam.bias.data = bias3 + bias1 + bias_id
            del self.rbr_dense
            del self.rbr_1x1
            if hasattr(self, "rbr_identity"):
                del self.rbr_identity
            self.deploy = True

    class PixelShuffleBlock(nn.Module):
        def __init__(self, in_channels: int, out_channels: int):
            super().__init__()
            self.conv = nn.Conv2d(in_channels, out_channels * 4, 3, padding=1)
            self.pixel_shuffle = nn.PixelShuffle(2)
            self.prelu = nn.PReLU()

        def forward(self, value):
            return self.prelu(self.pixel_shuffle(self.conv(value)))

    class NanoVSR(nn.Module):
        def __init__(self, num_feat: int, num_blocks: int):
            super().__init__()
            self.feat_extract = RepVGGBlock(3, num_feat)
            self.forward_net = nn.Sequential(*[RepVGGBlock(num_feat, num_feat) for _ in range(num_blocks)])
            self.backward_net = nn.Sequential(*[RepVGGBlock(num_feat, num_feat) for _ in range(num_blocks)])
            self.fusion = nn.Conv2d(num_feat * 2, num_feat, 1)
            self.upsample1 = PixelShuffleBlock(num_feat, num_feat)
            self.upsample2 = PixelShuffleBlock(num_feat, 32)
            self.conv_last = nn.Conv2d(32, 3, 3, padding=1)

        def forward(self, value):
            batch, frames, channels, height, width = value.size()
            features = self.feat_extract(value.view(-1, channels, height, width)).view(
                batch, frames, -1, height, width
            )
            forward_features = []
            propagated = torch.zeros_like(features[:, 0])
            for index in range(frames):
                propagated = self.forward_net(features[:, index] + propagated)
                forward_features.append(propagated)
            backward_features = []
            propagated = torch.zeros_like(features[:, 0])
            for index in range(frames - 1, -1, -1):
                propagated = self.backward_net(features[:, index] + propagated)
                backward_features.insert(0, propagated)
            outputs = []
            for index in range(frames):
                fused = self.fusion(torch.cat([forward_features[index], backward_features[index]], dim=1))
                output = self.conv_last(self.upsample2(self.upsample1(fused)))
                base = functional.interpolate(value[:, index], scale_factor=4, mode="bilinear", align_corners=False)
                outputs.append(output + base)
            return torch.stack(outputs, dim=1)

        def switch_to_deploy(self):
            for module in self.modules():
                if module is not self and hasattr(module, "switch_to_deploy"):
                    module.switch_to_deploy()

    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
    state = next(
        (
            checkpoint[key]
            for key in ("params_ema", "params", "model_state_dict")
            if isinstance(checkpoint, dict) and key in checkpoint
        ),
        checkpoint,
    )
    feature_key = next(
        key
        for key in ("feat_extract.rbr_dense.0.weight", "conv_first.rbr_dense.0.weight")
        if key in state
    )
    num_feat = int(state[feature_key].shape[0])
    block_indices = {
        int(key.split(".")[1])
        for key in state
        if key.startswith("forward_net.") and key.split(".")[1].isdigit()
    }
    model = NanoVSR(num_feat, max(block_indices) + 1)
    model.load_state_dict(state, strict=True)
    model.switch_to_deploy()
    resolved = torch.device(device if device != "auto" else ("cuda" if torch.cuda.is_available() else "cpu"))
    model.eval().to(resolved)
    if use_fp16 and resolved.type == "cuda":
        model.half()
    return model, resolved
