# PCA/HOG Combination Results

> Historical experiment only. The PCA/template and linear-classifier browser paths,
> plus their comparison harness, were removed during the TypeScript-single-source
> cleanup. These figures preserve evidence from that investigation; they are not
> current architecture, validation, or retraining guidance.

Training set: 800 samples. Same-distribution holdout: 200. Cross-font holdout: 10080.

| Combination | Train accuracy | Same-distribution accuracy | Cross-font accuracy |
|---|---|---|---|
| pca_stretch | 1.0000 | 1.0000 | 0.3383 |
| pca_letterbox | 1.0000 | 1.0000 | 0.5451 |
| hog_stretch | 1.0000 | 1.0000 | 0.7696 |
| hog_letterbox | 1.0000 | 1.0000 | 0.8755 |
