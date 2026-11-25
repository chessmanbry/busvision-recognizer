"""Read an iPhone's append-only field session without launching or attaching to its process."""
import json
import re
import tempfile
from datetime import datetime
from pathlib import Path


def copy_text(run, device, app, source, dest):
    run('xcrun','devicectl','device','copy','from','--device',device,'--domain-type','appDataContainer',
        '--domain-identifier',app,'--source','Documents/BusVisionField/'+source,'--destination',str(dest),'--quiet')
    return dest.read_text()


def poll_phone(run, device, app, cursor, session):
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        pointer = json.loads(copy_text(run, device, app, 'current.json', root/'pointer'))
        identifier, part = pointer['id'], pointer['part']
        if not re.fullmatch(r'[\dTZ-]{24}', identifier) or type(part) is not int or part < 0:
            raise ValueError('場次索引無效')
        if cursor.get('id') != identifier:
            cursor.update(id=identifier, seq=-1)
        for number in range((cursor['seq']+1)//100, part+1):
            name = f'{identifier}/events-{number:05d}.jsonl'
            data = copy_text(run, device, app, name, root/f'{number}.jsonl')
            for line in data.splitlines(keepends=True):
                if not line.endswith('\n'):
                    break
                row = json.loads(line)
                if row['seq'] <= cursor['seq']:
                    continue
                stamp = datetime.fromisoformat(row['at'].replace('Z', '+00:00'))
                if stamp.timestamp() >= session.wall_start:
                    from report import field_row
                    event = field_row(row)
                    if event:
                        session.add(device='ios', **event)
                cursor['seq'] = row['seq']


def ios_pid(run, device, app):
    def info(kind, *args):
        return json.loads(run('xcrun','devicectl','device','info',kind,'--device',device,
                              *args,'--json-output','-','--quiet'))['result']
    apps = info('apps','--bundle-id',app).get('apps',[])
    if not apps:
        return '未安裝'
    url = str(apps[0].get('url','')).rstrip('/')
    if not url:
        return '無法比對行程'
    processes = info('processes').get('runningProcesses',[])
    for proc in processes:
        if str(proc.get('executable','')).startswith(url+'/'):
            return str(proc.get('processIdentifier','執行中'))
    return '未執行'


def crash_names(run, device):
    raw = run('xcrun','devicectl','device','info','files','--device',device,'--domain-type','systemCrashLogs',
              '--json-output','-','--quiet')
    files = json.loads(raw)['result'].get('files',[])
    names = [str(f.get('name') or f.get('relativePath') or '') for f in files]
    return sorted(n for n in names if re.search(r'(?:^|/)(App-|BusVision|JetsamEvent)',n) and n.endswith('.ips'))
