# Bundled bus detector

TensorFlow.js COCO-SSD `ssdlite_mobilenet_v2`, fetched 2026-11-15.
Source: https://storage.googleapis.com/tfjs-models/savedmodel/ssdlite_mobilenet_v2/model.json
Library/source: https://github.com/tensorflow/tfjs-models/tree/master/coco-ssd
Model architecture: https://github.com/tensorflow/models/tree/master/research/object_detection

Bundled for offline inference. Only class `bus` at confidence >= 0.55 is used for alignment feedback. Two observations acquire; five seconds without a detection lose alignment. This is not a door detector, direction classifier, or boarding safety assessment. Test accuracy in real Taiwanese bus-stop conditions before relying on it.
