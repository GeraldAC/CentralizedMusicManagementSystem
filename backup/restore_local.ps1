<#
.SYNOPSIS
    Descarga el backup más reciente desde GitHub Actions y lo restaura
    en el PostgreSQL local. Diseñado para procesos ETL automatizados.

.DESCRIPTION
    Requiere:
      - gh CLI autenticado con permisos actions:read y actions:artifacts
      - pg_restore en PATH 
      - Archivo .pgpass configurado en %APPDATA%\postgresql\pgpass.conf (Recomendado)
        o proveer la contraseña mediante el parámetro -DbPassword.

.PARAMETER DbName
    Nombre de la base de datos destino. Por defecto: "gmc"

.PARAMETER DbUser
    Usuario de PostgreSQL. Por defecto: "postgres"

.PARAMETER DbPassword
    Contraseña de PostgreSQL en formato SecureString. Ignorado si existe .pgpass para esta conexión.

.PARAMETER Repo
    Repositorio en formato "usuario/repo". Por defecto: "GeraldAC/gmc"
#>

[CmdletBinding()]
param(
    [string]$DbName = "gmc",
    [string]$DbUser = "postgres",
    [securestring]$DbPassword = $null,
    [string]$Repo   = "GeraldAC/gmc"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# --------------------------------------------------------------------------
# 1. Verificar Prerrequisitos
# --------------------------------------------------------------------------
foreach ($tool in @("gh", "pg_restore")) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Write-Error "Prerrequisito faltante: '$tool' no está disponible en PATH."
        exit 1
    }
}

# --------------------------------------------------------------------------
# 2. Configuración de Entorno y Temporales
# --------------------------------------------------------------------------
$TmpDir = Join-Path $env:TEMP "gmc_restore_$(Get-Random)"
New-Item -ItemType Directory -Path $TmpDir | Out-Null
$PgPassPath = Join-Path $env:APPDATA "postgresql\pgpass.conf"
$Ptr = [System.IntPtr]::Zero

try {
    # --------------------------------------------------------------------------
    # 3. Obtener el Run ID del último run exitoso
    # --------------------------------------------------------------------------
    Write-Host "Buscando el último run exitoso de 'weekly.yml' en '$Repo'..." -ForegroundColor Cyan

    # Aislamos stdout de stderr para evitar fallos de parseo JSON (ej. HTTP 404)
    $RunListJson = gh run list `
        --repo $Repo `
        --workflow "weekly.yml" `
        --status success `
        --limit 1 `
        --json databaseId 2>$null

    if ($LASTEXITCODE -ne 0) {
        $ErrorMsg = gh run list --repo $Repo --workflow "weekly.yml" --limit 1 2>&1
        throw "Falló la consulta a GitHub CLI: $ErrorMsg"
    }

    if ([string]::IsNullOrWhiteSpace($RunListJson)) {
        throw "No se encontraron ejecuciones exitosas para 'weekly.yml'."
    }

    $RunList = $RunListJson | ConvertFrom-Json
    if ($RunList.Count -eq 0) { throw "La lista de runs está vacía." }

    $RunId = $RunList[0].databaseId
    $ArtifactName = "gmc-backup-$RunId"
    Write-Host "[✓] Run ID encontrado: $RunId → artefacto: '$ArtifactName'"

    # --------------------------------------------------------------------------
    # 4. Descargar el artefacto
    # --------------------------------------------------------------------------
    Write-Host "Descargando artefacto desde GitHub Actions..."
    gh run download $RunId --repo $Repo --name $ArtifactName --dir $TmpDir
    if ($LASTEXITCODE -ne 0) { throw "Error al descargar el artefacto 'gmc-backup-$RunId'." }

    # --------------------------------------------------------------------------
    # 5. Localizar el archivo .dump
    # --------------------------------------------------------------------------
    $DumpFile = Get-ChildItem -Path $TmpDir -Filter "*.dump" -Recurse |
                Sort-Object LastWriteTime -Descending |
                Select-Object -First 1

    if (-not $DumpFile) {
        throw "No se encontró ningún archivo .dump en el directorio temporal."
    }
    Write-Host "[✓] Archivo encontrado: $($DumpFile.Name)"

    # --------------------------------------------------------------------------
    # 6. Preparar Autenticación Segura
    # --------------------------------------------------------------------------
    $UsingPgPass = Test-Path $PgPassPath

    if (-not $UsingPgPass -and ($null -ne $DbPassword)) {
        Write-Host "Usando autenticación temporal en memoria (SecureString)." -ForegroundColor DarkGray
        $Ptr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($DbPassword)
        $PlainPassword = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($Ptr)
        $env:PGPASSWORD = $PlainPassword
    } elseif (-not $UsingPgPass -and ($null -eq $DbPassword)) {
        Write-Host "[!] Advertencia: No se detectó .pgpass ni contraseña. pg_restore podría fallar si el usuario requiere autenticación." -ForegroundColor Yellow
    } else {
        Write-Host "Autenticación delegada al archivo de configuración .pgpass local." -ForegroundColor DarkGray
    }

    # --------------------------------------------------------------------------
    # 7. Restaurar en PostgreSQL local
    # --------------------------------------------------------------------------
    Write-Host "Restaurando '$($DumpFile.Name)' en la BD '$DbName'..." -ForegroundColor Cyan

    $pgRestoreArgs = @(
        "--clean",
        "--if-exists",
        "--no-owner",
        "--no-acl",
        "--dbname", $DbName,
        "--username", $DbUser,
        $DumpFile.FullName
    )

    $process = Start-Process -FilePath "pg_restore" `
        -ArgumentList $pgRestoreArgs `
        -NoNewWindow `
        -Wait `
        -PassThru

    # Evaluación estricta de códigos de salida
    if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 1) {
        throw "pg_restore falló con código de error crítico $($process.ExitCode)."
    } elseif ($process.ExitCode -eq 1) {
        Write-Host "Nota: pg_restore finalizó con advertencias (Exit Code 1). Es normal al usar --clean si la BD estaba vacía." -ForegroundColor Yellow
    }

    Write-Host "`nRestauración completada con éxito." -ForegroundColor Green
    Write-Host "Base de datos: $DbName | Usuario: $DbUser"

} catch {
    Write-Host "`n[✕] Error Crítico durante la ejecución:" -ForegroundColor Red
    Write-Host $_.Exception.Message
    exit 1
} finally {
    # --------------------------------------------------------------------------
    # 8. Limpieza rigurosa de seguridad y temporales
    # --------------------------------------------------------------------------
    # Limpiar contraseña de la memoria y variables de entorno
    if ($Ptr -ne [System.IntPtr]::Zero) {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Ptr)
    }
    if (Test-Path env:PGPASSWORD) { 
        Remove-Item env:PGPASSWORD -ErrorAction SilentlyContinue 
    }

    # Limpiar directorio temporal
    if (Test-Path $TmpDir) {
        Remove-Item -Recurse -Force $TmpDir
        Write-Host "Archivos temporales eliminados de forma segura." -ForegroundColor DarkGray
    }
}