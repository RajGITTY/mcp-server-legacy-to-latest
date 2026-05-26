<?php
declare(strict_types=1);

/**
 * Modernized User Login Script
 * 
 * Improvements:
 * - PDO with Prepared Statements (SQL Injection Protection)
 * - Password Hashing (assuming password_verify)
 * - Centralized Error Handling
 * - Secure Session Management
 * - Use of htmlspecialchars for output (XSS protection)
 */

// Load configuration from environment variables or a secure config file
// In a real project, use a library like vlucas/phpdotenv
$db_host = $_ENV['DB_HOST'] ?? 'localhost';
$db_user = $_ENV['DB_USER'] ?? 'root';
$db_pass = $_ENV['DB_PASS'] ?? '';
$db_name = $_ENV['DB_NAME'] ?? 'times_internet_db';

try {
    $dsn = "mysql:host=$db_host;dbname=$db_name;charset=utf8mb4";
    $options = [
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES   => false,
    ];
    
    $pdo = new PDO($dsn, $db_user, $db_pass, $options);
} catch (\PDOException $e) {
    // Log error and show generic message to user
    error_log("Database Connection Error: " . $e->getMessage());
    http_response_code(500);
    exit("Internal Server Error. Please try again later.");
}

// Basic input validation
$username = $_POST['user'] ?? null;
$password = $_POST['pass'] ?? null;

if (!$username || !$password) {
    http_response_code(400);
    exit("Invalid input: Username and password are required.");
}

try {
    /**
     * SECURE: Using Prepared Statements to prevent SQL Injection.
     * Note: We fetch the user by username and then verify the password hash in PHP.
     * The legacy code checked the password directly in SQL, which often implies plain-text storage.
     */
    $stmt = $pdo->prepare("SELECT id, username, password_hash FROM users WHERE username = ?");
    $stmt->execute([$username]);
    $user = $stmt->fetch();

    if ($user && password_verify($password, $user['password_hash'])) {
        // Secure Session Initialization
        if (session_status() === PHP_SESSION_NONE) {
            session_start([
                'cookie_httponly' => true,
                'cookie_secure' => true, // Ensure this is true if using HTTPS
                'samesite' => 'Lax',
            ]);
        }
        
        // Prevent session fixation attacks
        session_regenerate_id(true);
        
        $_SESSION['user_id'] = $user['id'];
        $_SESSION['username'] = $user['username'];
        
        echo "Login successful! Welcome " . htmlspecialchars($user['username'], ENT_QUOTES, 'UTF-8');
    } else {
        // Use a generic message for both "user not found" and "wrong password" to prevent user enumeration
        http_response_code(401);
        echo "Invalid credentials.";
    }
} catch (\Exception $e) {
    error_log("Authentication Error: " . $e->getMessage());
    http_response_code(500);
    echo "An unexpected error occurred. Please try again later.";
}
