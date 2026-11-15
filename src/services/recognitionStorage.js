import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';

const LOG_FILE = 'BusData/recognition_logs.json';

// Serialize reads and mutations so a correction cannot overwrite a new result.
export function createRecognitionStore(filesystem) {
  let queue = Promise.resolve();
  const enqueue = (operation) => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  const read = async () => {
    let response;
    try {
      response = await filesystem.readFile({ path: LOG_FILE, directory: Directory.Data, encoding: Encoding.UTF8 });
    } catch (error) {
      if (error?.code === 'OS-PLUG-FILE-0008' || error?.code === 'ENOENT' || error?.message === 'File does not exist.') return [];
      throw error;
    }
    const data = JSON.parse(response.data);
    if (!Array.isArray(data) || data.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
      throw new Error('辨識紀錄格式損壞，請先匯出原始資料再處理');
    }
    return data;
  };
  const mutate = (change) => enqueue(async () => {
    const items = change(await read());
    await filesystem.writeFile({
      path: LOG_FILE, directory: Directory.Data, encoding: Encoding.UTF8,
      data: JSON.stringify(items), recursive: true,
    });
    return items;
  });
  return {
    readLogs: () => enqueue(read),
    appendLog: (item) => mutate((items) => [...items, item].slice(-1000)),
    updateLog: (id, patch) => mutate((items) => {
      if (!items.some((item) => item.id === id)) throw new Error('這筆紀錄已移除，請重新整理');
      return items.map((item) => item.id === id ? { ...item, ...patch, id } : item);
    }),
    clearLogs: () => mutate(() => []),
  };
}

export const { readLogs, appendLog, updateLog, clearLogs } = createRecognitionStore(Filesystem);
