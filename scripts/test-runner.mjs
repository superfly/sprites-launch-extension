import { spawnSync } from 'node:child_process';

// Apple's bundled Python can omit OpenSSL scrypt. Use a compatible interpreter
// for Hermes' executable authentication tests, without changing system Python.
const candidates=process.env.SPRITES_TEST_PYTHON?[process.env.SPRITES_TEST_PYTHON]:['python3.14','python3.13','python3.12','python3.11','python3'];
const python=candidates.find(candidate=>spawnSync(candidate,['-c','import sys,hashlib; assert sys.version_info >= (3,11); hashlib.scrypt(b"probe",salt=b"probe",n=2,r=1,p=1)'],{stdio:'ignore'}).status===0);
if(!python){
  process.stderr.write('Runner tests require Python 3.11+ with hashlib.scrypt. Set SPRITES_TEST_PYTHON to a compatible interpreter.\n');
  process.exit(1);
}
const result=spawnSync(python,['-m','unittest','discover','-s','runner','-p','test_*.py'],{stdio:'inherit'});
if(result.error)process.stderr.write(result.error.message+'\n');
process.exit(result.status??1);
