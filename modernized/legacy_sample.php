<?php

require_once __DIR__ . '/UserAuth.php';

use Modernized\Auth\UserAuth;

// Mock configuration - in production, use environment variables
$config = [
    'host' => 'localhost',
    'db'   => 'times_internet_db',
    'user' => 'root',
    'pass' => '' // Consider loading from environment variables or a secure configuration
];

try {
    $auth = new UserAuth($config);

    // Get input from POST, use null coalescing for safety
    $username = $_POST['user'] ?? '';
    $password = $_POST['pass'] ?? '';

    if (empty($username) || empty($password)) {
        echo "Please provide both username and password.";
        exit;
    }

    $user = $auth->login($username, $password);

    if ($user) {
        $auth->createSession($user);
        echo "Login successful! Welcome " . htmlspecialchars($user['username'], ENT_QUOTES, 'UTF-8');
    } else {
        http_response_code(401);
        echo "Invalid credentials.";
    }

} catch (Exception $e) {
    // Log exception and show a user-friendly message
    error_log($e->getMessage());
    http_response_code(500);
    echo "An internal error occurred. Please try again later.";
}
