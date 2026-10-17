# calistir.bat acik oldukca bilgisayarin uykuya gitmesini engeller.
# Bat penceresi kapaninca kendiliginden biter ve normal uyku ayarlari geri gelir.
$sig = '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'
Add-Type -MemberDefinition $sig -Name Pw -Namespace Hat | Out-Null
$parent = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId
$ES = [uint32]2147483649   # ES_CONTINUOUS | ES_SYSTEM_REQUIRED
[Hat.Pw]::SetThreadExecutionState($ES) | Out-Null
while (Get-Process -Id $parent -ErrorAction SilentlyContinue) {
  Start-Sleep -Seconds 20
  [Hat.Pw]::SetThreadExecutionState($ES) | Out-Null
}
[Hat.Pw]::SetThreadExecutionState([uint32]2147483648) | Out-Null
