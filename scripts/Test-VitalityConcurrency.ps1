param([string]$ApiBase = 'http://localhost:4000')

$ErrorActionPreference = 'Stop'
$ApiBase = $ApiBase.TrimEnd('/')
Add-Type -AssemblyName System.Net.Http

function Get-MemberLogin {
    param([string]$Label)
    $email = (Read-Host "$Label email").Trim()
    $secret = Read-Host "$Label password" -AsSecureString
    try {
        $body = @{
            email = $email
            password = [System.Net.NetworkCredential]::new('', $secret).Password
        } | ConvertTo-Json -Compress
        $login = Invoke-RestMethod "$ApiBase/api/auth/login" -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 15
        if ($login.member.role -ne 'MEMBER') { throw 'Use a regular member account.' }
        $membership = Invoke-RestMethod "$ApiBase/api/members/$($login.member.id)/membership" -Headers @{Authorization="Bearer $($login.token)"} -TimeoutSec 15
        if (-not $membership.is_active) { throw 'This member needs an active membership.' }
        return $login
    } finally {
        $body = $null
        $secret.Dispose()
    }
}

$sessions = @((Invoke-RestMethod "$ApiBase/api/sessions" -TimeoutSec 15).sessions | Where-Object {
    [int]$_.available_places -eq 1 -and [DateTimeOffset]$_.starts_at -gt [DateTimeOffset]::UtcNow
})
if ($sessions.Count -eq 0) { throw 'No future sessions have exactly one available seat.' }
for ($i = 0; $i -lt $sessions.Count; $i++) {
    $item = $sessions[$i]
    Write-Host ("{0}. {1} | {2} | capacity {3} | one seat left" -f ($i+1), $item.class_name, ([DateTimeOffset]$item.starts_at).ToLocalTime(), $item.capacity)
}
$selection = 0
if (-not [int]::TryParse((Read-Host 'Enter the session number'), [ref]$selection) -or $selection -lt 1 -or $selection -gt $sessions.Count) {
    throw 'Invalid session selection.'
}
$session = $sessions[$selection-1]
$logins = @((Get-MemberLogin 'Member A'), (Get-MemberLogin 'Member B'))
if ($logins[0].member.id -eq $logins[1].member.id) { throw 'Use two different members.' }

foreach ($login in $logins) {
    $existing = (Invoke-RestMethod "$ApiBase/api/bookings/me" -Headers @{Authorization="Bearer $($login.token)"} -TimeoutSec 15).bookings
    $matching = @($existing | Where-Object {
        $_.status -eq 'CONFIRMED' -and $_.class_name -eq $session.class_name -and
        [DateTimeOffset]$_.starts_at -eq [DateTimeOffset]$session.starts_at
    })
    if ($matching.Count -gt 0) { throw 'A selected member already booked this class at this time. Use an unbooked member.' }
}

$current = (Invoke-RestMethod "$ApiBase/api/sessions" -TimeoutSec 15).sessions | Where-Object id -eq $session.id
if (-not $current -or [int]$current.available_places -ne 1) { throw 'The session no longer has exactly one seat available.' }
Write-Host ''
Write-Host "Session ID: $($session.id)"
Write-Host 'This test will submit two real booking requests for the remaining seat.'
$null = Read-Host 'Press Enter to submit both requests concurrently, or Ctrl+C to cancel'

$client = [System.Net.Http.HttpClient]::new()
$client.Timeout = [TimeSpan]::FromSeconds(20)
$requests = @()
$responses = @()
try {
    foreach ($login in $logins) {
        $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, "$ApiBase/api/bookings")
        $request.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $login.token)
        $request.Content = [System.Net.Http.StringContent]::new((@{sessionId=$session.id} | ConvertTo-Json -Compress), [System.Text.Encoding]::UTF8, 'application/json')
        $requests += $request
    }
    # Start both asynchronous sends before waiting for either response.
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    $taskA = $client.SendAsync($requests[0])
    $sentA = $clock.Elapsed.TotalMilliseconds
    $taskB = $client.SendAsync($requests[1])
    $sentB = $clock.Elapsed.TotalMilliseconds
    $tasks = @($taskA, $taskB)
    $results = @()
    for ($i=0; $i -lt 2; $i++) {
        $response = $tasks[$i].GetAwaiter().GetResult()
        $responses += $response
        $data = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
        $results += [PSCustomObject]@{
            Member = $logins[$i].member.full_name
            HTTP = [int]$response.StatusCode
            Result = if ([int]$response.StatusCode -eq 201) {'Booking confirmed'} else {$data.error}
            BookingId = $data.booking.id
            EventId = $data.event_id
        }
    }
    $results | Format-List
    Write-Host ('Send calls started {0:N2} ms apart; both requests were sent without waiting for a response.' -f ($sentB-$sentA))
    $after = (Invoke-RestMethod "$ApiBase/api/sessions" -TimeoutSec 15).sessions | Where-Object id -eq $session.id
    Write-Host "Session ID: $($session.id)"
    Write-Host "Remaining seats after test: $($after.available_places)"
    $successes = @($results | Where-Object HTTP -eq 201).Count
    $full = @($results | Where-Object { $_.HTTP -eq 409 -and $_.Result -eq 'Class is full' }).Count
    if ($successes -eq 1 -and $full -eq 1 -and $after -and [int]$after.available_places -eq 0) {
        Write-Host 'PASS: one booking accepted, one rejected as full, zero seats remaining.' -ForegroundColor Green
    } else {
        Write-Host 'Unexpected result. Save this output and investigate before retrying.' -ForegroundColor Yellow
    }
} catch {
    Write-Warning 'A request may have reached the server. Check the session roster before running this test again.'
    throw
} finally {
    foreach ($response in $responses) { $response.Dispose() }
    foreach ($request in $requests) { $request.Dispose() }
    $client.Dispose()
    $logins = $null
}
