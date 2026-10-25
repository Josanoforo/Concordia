$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$envRoot = Join-Path $root '.concordia'
$venv = Join-Path $envRoot 'python/coma-valentine-1.1.0'
$cache = Join-Path $envRoot 'cache/pip-coma'
$temp = Join-Path $envRoot 'tmp/coma-install'
New-Item -ItemType Directory -Force -Path $cache, $temp | Out-Null
$env:PIP_CACHE_DIR = $cache
$env:TEMP = $temp
$env:TMP = $temp
$env:TMPDIR = $temp
if (-not (Test-Path -LiteralPath (Join-Path $venv 'Scripts/python.exe'))) {
  py -3.12 -m venv $venv
  if ($LASTEXITCODE -ne 0) { throw 'PYTHON_VENV_CREATE_FAILED' }
}
& (Join-Path $venv 'Scripts/python.exe') -m pip install --disable-pip-version-check --requirement (Join-Path $PSScriptRoot 'requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'VALENTINE_INSTALL_FAILED' }
& (Join-Path $venv 'Scripts/python.exe') -c "from importlib.metadata import version; installed = version('valentine'); assert installed == '1.1.0'; print(installed)"
if ($LASTEXITCODE -ne 0) { throw 'VALENTINE_VERSION_CHECK_FAILED' }
