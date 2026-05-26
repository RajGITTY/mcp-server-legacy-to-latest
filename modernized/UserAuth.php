<?php

namespace Modernized\Auth;

use PDO;
use PDOException;
use Exception;

/**
 * Class UserAuth
 * 
 * Modernized Authentication service.
 */
class UserAuth {
    private ?PDO $db = null;

    public function __construct(array $config) {
        $this->connect($config);
    }

    /**
     * Establish a secure PDO connection
     */
    private function connect(array $config): void {
        $dsn = "mysql:host={$config['host']};dbname={$config['db']};charset=utf8mb4";
        $options = [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
        ];

        try {
            $this->db = new PDO($dsn, $config['user'], $config['pass'], $options);
        } catch (PDOException $e) {
            // In production, log the error and show a generic message
            throw new Exception("Database connection failed: " . $e->getMessage());
        }
    }

    /**
     * Authenticate a user using prepared statements and password verification.
     * 
     * @param string $username
     * @param string $password
     * @return array|null
     */
    public function login(string $username, string $password): ?array {
        try {
            // Note: In a real system, we only fetch by username and then verify password hash
            $stmt = $this->db->prepare("SELECT id, username, password_hash FROM users WHERE username = :username");
            $stmt->execute(['username' => $username]);
            $user = $stmt->fetch();

            if ($user && password_verify($password, $user['password_hash'])) {
                // Remove password hash before returning user data
                unset($user['password_hash']);
                return $user;
            }
        } catch (PDOException $e) {
            // Log error
            error_log($e->getMessage());
        }

        return null;
    }

    /**
     * Start a secure session and store user data
     */
    public function createSession(array $user): void {
        if (session_status() === PHP_SESSION_NONE) {
            session_start([
                'cookie_lifetime' => 86400,
                'cookie_httponly' => true,
                'cookie_secure' => true, // Ensure this is true in production with HTTPS
                'samesite' => 'Lax',
            ]);
        }
        $_SESSION['user_id'] = $user['id'];
        $_SESSION['username'] = $user['username'];
    }
}
