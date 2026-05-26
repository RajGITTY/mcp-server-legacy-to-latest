<?php
// Legacy User Login Script
// Notice: No proper error handling, raw SQL, global variables

$db_host = "localhost";
$db_user = "root";
$db_pass = "";
$db_name = "times_internet_db";

$conn = mysqli_connect($db_host, $db_user, $db_pass, $db_name);

if (!$conn) {
    die("Connection failed: " . mysqli_connect_error());
}

$username = $_POST['user'];
$password = $_POST['pass'];

// VULNERABLE: Direct SQL injection risk
$sql = "SELECT id, username FROM users WHERE username = '$username' AND password = '$password'";
$result = mysqli_query($conn, $sql);

if (mysqli_num_rows($result) > 0) {
    // START SESSION
    session_start();
    $row = mysqli_fetch_assoc($result);
    $_SESSION['user_id'] = $row['id'];
    echo "Login successful! Welcome " . $row['username'];
} else {
    echo "Invalid credentials.";
}

mysqli_close($conn);
?>
