export function createVehicleDetector(loadModel) {
  let loading;
  let model;
  let prediction;
  let disposed = false;

  function load() {
    if (disposed) return Promise.resolve(null);
    loading ??= Promise.resolve().then(loadModel).then((loadedModel) => {
      if (disposed) {
        loadedModel.dispose();
        return null;
      }
      model = loadedModel;
      return model;
    }).catch((error) => {
      loading = undefined;
      throw error;
    });
    return loading;
  }

  function predict(input, limit) {
    if (disposed || !model || prediction) return null;
    prediction = Promise.resolve().then(() => model.detect(input, limit)).finally(() => {
      prediction = undefined;
      if (disposed) {
        model.dispose();
        model = undefined;
      }
    });
    return prediction;
  }

  function dispose() {
    disposed = true;
    if (model && !prediction) {
      model.dispose();
      model = undefined;
    }
  }

  return { load, predict, dispose };
}
